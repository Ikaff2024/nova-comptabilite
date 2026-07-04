import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { withUser, pool } from './db.js';
import * as acc from './domain/accounting.js';
import * as users from './domain/users.js';
import { hashPassword, verifyPassword, issueToken, verifyToken, generateTotpSecret, totpUri, verifyTotp } from './auth.js';
import { extractDocument, aiProvider } from './ai/provider.js';
import * as mm from './domain/mobilemoney.js';
import * as lettrage from './domain/lettrage.js';
import * as bank from './domain/bank.js';
import * as tiers from './domain/tiers.js';
import * as invoicing from './domain/invoicing.js';
import * as tax from './domain/tax.js';
import * as importbalance from './domain/importbalance.js';
import * as assets from './domain/assets.js';
import * as audit from './domain/audit.js';
import { dossierDashboard } from './domain/dossierdashboard.js';
import * as recurring from './domain/recurring.js';
import * as documents from './domain/documents.js';
import * as relances from './domain/relances.js';

// ============================================================================
// API HTTP — fine couche au-dessus du domaine. Chaque route s'exécute dans une
// transaction avec l'identité courante (RLS). Aucune SQL ici.
// ============================================================================

export function createApi() {
  const app = express();
  app.use(express.json({ limit: '15mb' })); // images de pièces en base64

  // --- Auth : identité issue d'un JWT (Authorization: Bearer <token>).
  app.use((req: Request & { userId?: string }, _res, next: NextFunction) => {
    const auth = req.header('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const payload = token ? verifyToken(token) : null;
    req.userId = payload?.sub;
    next();
  });

  const h = (fn: (req: any, res: Response) => Promise<any>) =>
    (req: Request, res: Response) => fn(req, res).catch((e: any) => {
      const status = e?.status ?? 400;
      res.status(status).json({ error: e?.message ?? 'Erreur', code: e?.code });
    });

  const requireUser = (req: any) => {
    if (!req.userId) { const e: any = new Error('Authentification requise'); e.status = 401; throw e; }
    return req.userId as string;
  };

  app.get('/api/health', async (_req, res) => {
    try { await pool.query('select 1'); res.json({ ok: true, db: true, service: 'nova-comptabilite-api' }); }
    catch { res.status(503).json({ ok: false, db: false, service: 'nova-comptabilite-api' }); }
  });

  // --- Authentification -------------------------------------------------------

  app.post('/api/auth/register', h(async (req, res) => {
    const { email, password, name } = req.body ?? {};
    if (!email || !password) { const e: any = new Error('Email et mot de passe requis'); e.status = 400; throw e; }
    if (String(password).length < 8) { const e: any = new Error('Mot de passe : 8 caractères minimum'); e.status = 400; throw e; }
    try {
      const id = await withUser(null, (c) => users.registerUser(c, email, hashPassword(password), name ?? null));
      const token = issueToken({ id, email: String(email).toLowerCase().trim(), name });
      res.status(201).json({ token, user: { id, email: String(email).toLowerCase().trim(), name } });
    } catch (err: any) {
      if (String(err.message).includes('EMAIL_TAKEN')) { const e: any = new Error('Cet email est déjà utilisé'); e.status = 409; throw e; }
      throw err;
    }
  }));

  app.post('/api/auth/login', h(async (req, res) => {
    const { email, password, code } = req.body ?? {};
    const row = await withUser(null, (c) => users.getUserForLogin(c, String(email ?? '')));
    if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
      const e: any = new Error('Identifiants invalides'); e.status = 401; throw e;
    }
    if (row.totp_enabled) {
      if (!code) { const e: any = new Error('Code de vérification requis'); e.status = 401; e.code = '2FA_REQUIRED'; throw e; }
      if (!verifyTotp(row.totp_secret ?? '', String(code))) { const e: any = new Error('Code de vérification invalide'); e.status = 401; e.code = '2FA_INVALID'; throw e; }
    }
    const token = issueToken({ id: row.id, email: row.email, name: row.name ?? undefined });
    res.json({ token, user: { id: row.id, email: row.email, name: row.name, twoFactorEnabled: row.totp_enabled } });
  }));

  app.get('/api/auth/me', h(async (req, res) => {
    const userId = requireUser(req);
    const user = await withUser(userId, (c) => users.getUser(c, userId));
    if (!user) { const e: any = new Error('Utilisateur introuvable'); e.status = 404; throw e; }
    res.json({ id: user.id, email: user.email, name: user.name, twoFactorEnabled: user.totp_enabled });
  }));

  // --- Double authentification (2FA TOTP) ------------------------------------
  app.post('/api/auth/2fa/setup', h(async (req, res) => {
    const userId = requireUser(req);
    const me = await withUser(userId, (c) => users.getUser(c, userId));
    const secret = generateTotpSecret();
    await withUser(userId, (c) => users.totpSetPending(c, secret));
    res.json({ secret, otpauth: totpUri(secret, me?.email ?? 'user') });
  }));
  app.post('/api/auth/2fa/enable', h(async (req, res) => {
    const userId = requireUser(req);
    const { code } = req.body ?? {};
    const row = await withUser(userId, (c) => users.getUser(c, userId));
    // relit le secret en attente via le login helper (par email)
    const full = await withUser(null, (c) => users.getUserForLogin(c, row?.email ?? ''));
    if (!full?.totp_secret) { const e: any = new Error("Lancez d'abord la configuration 2FA."); e.status = 400; throw e; }
    if (!verifyTotp(full.totp_secret, String(code ?? ''))) { const e: any = new Error('Code invalide — réessayez.'); e.status = 400; throw e; }
    await withUser(userId, (c) => users.totpEnable(c));
    res.json({ enabled: true });
  }));
  app.post('/api/auth/2fa/disable', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => users.totpDisable(c));
    res.json({ enabled: false });
  }));

  // --- Membres du cabinet (collaborateurs & rôles) ---------------------------
  app.get('/api/cabinets/:cid/members', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => users.listMembers(c, req.params.cid)));
  }));
  app.post('/api/cabinets/:cid/members', h(async (req, res) => {
    const userId = requireUser(req);
    const { email, role } = req.body ?? {};
    if (!email) { const e: any = new Error('Email requis'); e.status = 400; throw e; }
    res.status(201).json(await withUser(userId, (c) => users.addMember(c, req.params.cid, String(email), role || 'collaborateur')));
  }));
  app.patch('/api/cabinets/:cid/members/:uid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => users.setMemberRole(c, req.params.cid, req.params.uid, req.body?.role));
    res.status(204).end();
  }));
  app.delete('/api/cabinets/:cid/members/:uid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => users.removeMember(c, req.params.cid, req.params.uid));
    res.status(204).end();
  }));

  // Onboarding : créer un cabinet (l'appelant en devient owner)
  app.post('/api/onboarding/cabinet', h(async (req, res) => {
    const userId = requireUser(req);
    const { name, country, currency } = req.body ?? {};
    const id = await withUser(userId, (c) => acc.onboardCabinet(c, userId, name, country, currency));
    res.status(201).json({ cabinetId: id });
  }));

  app.get('/api/cabinets', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => acc.listCabinets(c)));
  }));

  app.get('/api/dashboard', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => acc.cabinetDashboard(c)));
  }));

  app.post('/api/demo/seed', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, async (c) => {
      const cabs = await acc.listCabinets(c);
      if (!cabs[0]) { const e: any = new Error('Aucun cabinet'); e.status = 400; throw e; }
      return acc.seedDemoDossier(c, cabs[0].id);
    });
    res.status(201).json(out);
  }));

  app.get('/api/dossiers', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => acc.listDossiers(c)));
  }));

  app.post('/api/dossiers', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => acc.openDossier(c, req.body));
    res.status(201).json(out);
  }));

  app.get('/api/dossiers/:id/accounts', h(async (req, res) => {
    const userId = requireUser(req);
    const classNo = req.query.class ? Number(req.query.class) : undefined;
    const search = (req.query.q as string) || undefined;
    res.json(await withUser(userId, (c) => acc.listAccounts(c, req.params.id, { classNo, search })));
  }));

  app.get('/api/dossiers/:id/fiscal-years', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => acc.listFiscalYears(c, req.params.id)));
  }));

  app.post('/api/dossiers/:id/fiscal-years', h(async (req, res) => {
    const userId = requireUser(req);
    const { label, startDate, endDate } = req.body ?? {};
    const id = await withUser(userId, (c) => acc.createFiscalYear(c, req.params.id, label, startDate, endDate));
    res.status(201).json({ fiscalYearId: id });
  }));

  app.get('/api/dossiers/:id/journals', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => acc.listJournals(c, req.params.id)));
  }));

  app.post('/api/dossiers/:id/journals', h(async (req, res) => {
    const userId = requireUser(req);
    const { code, label, type } = req.body ?? {};
    const id = await withUser(userId, (c) => acc.createJournal(c, req.params.id, code, label, type));
    res.status(201).json({ journalId: id });
  }));

  app.post('/api/dossiers/:id/setup', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => acc.setupDossierDefaults(c, req.params.id)));
  }));

  // Capture IA : pièce -> proposition d'écriture (NE valide pas, ne poste pas).
  app.post('/api/dossiers/:id/capture', h(async (req, res) => {
    const userId = requireUser(req);
    const { mimeType, dataBase64 } = req.body ?? {};
    if (!mimeType || !dataBase64) { const e: any = new Error('Document requis (mimeType, dataBase64)'); e.status = 400; throw e; }

    const proposal = await withUser(userId, async (c) => {
      const dossiers = await acc.listDossiers(c);
      const dossier = dossiers.find((d: any) => d.id === req.params.id);
      if (!dossier) { const e: any = new Error('Dossier introuvable'); e.status = 404; throw e; }

      const [mappings, rules, chart] = await Promise.all([
        acc.getLearnedMappings(c, req.params.id),
        acc.getManualRules(c, req.params.id),
        acc.getAccountsForPrompt(c, req.params.id),
      ]);
      const p = await extractDocument({
        mimeType, dataBase64,
        context: { country: dossier.country, currency: dossier.base_currency, accountingSystem: dossier.accounting_system, mappings, rules, chart },
      });

      // Ancrage : signaler les comptes proposés absents du plan du dossier
      const codes = [...new Set(p.lines.map((l) => l.accountCode).filter(Boolean))];
      if (codes.length) {
        const { rows } = await c.query(
          'select account_code from accounts where dossier_id=$1 and account_code = any($2)',
          [req.params.id, codes],
        );
        const known = new Set(rows.map((r: any) => r.account_code));
        const unknown = codes.filter((code) => !known.has(code));
        if (unknown.length) {
          p.warnings = [...(p.warnings ?? []), `Comptes hors plan à vérifier : ${unknown.join(', ')}`];
        }
      }
      return p;
    });

    res.json({ provider: aiProvider(), proposal });
  }));

  app.post('/api/dossiers/:id/entries', h(async (req, res) => {
    const userId = requireUser(req);
    const input = { ...req.body, dossierId: req.params.id, createdBy: userId };
    const out = await withUser(userId, (c) => acc.postEntry(c, input));
    res.status(201).json(out);
  }));

  // --- Mobile Money : analyse d'un relevé -> propositions pré-catégorisées ----
  app.post('/api/dossiers/:id/mobile-money/parse', h(async (req, res) => {
    const userId = requireUser(req);
    const { provider, content } = req.body ?? {};
    if (!provider || !content) { const e: any = new Error('provider et content requis'); e.status = 400; throw e; }
    const proposals = await withUser(userId, (c) => mm.mobileMoneyProposals(c, req.params.id, provider, content));
    res.json({ count: proposals.length, proposals });
  }));

  // --- Mobile Money : import par lot (une écriture par mouvement, dédup) -------
  app.post('/api/dossiers/:id/mobile-money/import', h(async (req, res) => {
    const userId = requireUser(req);
    const { fiscalYearId, treasuryCode, entries } = req.body ?? {};
    if (!fiscalYearId || !Array.isArray(entries)) { const e: any = new Error('fiscalYearId et entries requis'); e.status = 400; throw e; }

    const journalId = await withUser(userId, async (c) => {
      const js = await acc.listJournals(c, req.params.id);
      const bq = js.find((j: any) => j.code === 'BQ') ?? js.find((j: any) => j.type === 'banque');
      if (!bq) { const e: any = new Error('Journal de banque (BQ) absent — initialisez le dossier.'); e.status = 400; throw e; }
      return bq.id;
    });

    let imported = 0, skipped = 0;
    const errors: { externalRef: string; message: string }[] = [];
    for (const e of entries) {
      try {
        await withUser(userId, (c) => mm.postEntry(c, mm.toPostInput(e, req.params.id, fiscalYearId, journalId, treasuryCode || '521')));
        imported++;
      } catch (err: any) {
        if (err?.code === '23505') skipped++; // déjà importé (external_ref unique)
        else errors.push({ externalRef: e.externalRef, message: err?.message ?? 'Erreur' });
      }
    }
    res.json({ imported, skipped, errors });
  }));

  app.post('/api/entries/:id/reverse', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => acc.reverseEntry(c, req.params.id, req.body?.date));
    res.status(201).json(out);
  }));

  // Règles de codification (manuel + appris)
  app.get('/api/dossiers/:id/mappings', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => acc.listMappings(c, req.params.id)));
  }));

  app.post('/api/dossiers/:id/mappings', h(async (req, res) => {
    const userId = requireUser(req);
    const { keyword, accountCode } = req.body ?? {};
    const rule = await withUser(userId, (c) => acc.upsertManualRule(c, req.params.id, keyword, accountCode));
    res.status(201).json(rule);
  }));

  app.delete('/api/dossiers/:id/mappings/:mappingId', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => acc.deleteMapping(c, req.params.id, req.params.mappingId));
    res.status(204).end();
  }));

  app.get('/api/dossiers/:id/trial-balance', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => acc.trialBalance(c, req.params.id, fy)));
  }));

  // --- Déclaration de TVA ----------------------------------------------------
  app.get('/api/dossiers/:id/vat', h(async (req, res) => {
    const userId = requireUser(req);
    const from = (req.query.from as string) || '', to = (req.query.to as string) || '';
    if (!from || !to) { const e: any = new Error('from et to requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => tax.vatDeclaration(c, req.params.id, from, to)));
  }));
  app.post('/api/dossiers/:id/vat/liquidate', h(async (req, res) => {
    const userId = requireUser(req);
    const { from, to, date } = req.body ?? {};
    if (!from || !to || !date) { const e: any = new Error('from, to, date requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => tax.postVatLiquidation(c, req.params.id, from, to, date)));
  }));

  // --- Import / reprise de balance (migration depuis un autre logiciel) -------
  app.post('/api/dossiers/:id/import-balance/analyze', h(async (req, res) => {
    const userId = requireUser(req);
    const { csv, lines, fiscalYearId } = req.body ?? {};
    const parsed = Array.isArray(lines) ? lines : importbalance.parseBalanceCsv(String(csv ?? ''));
    res.json(await withUser(userId, (c) => importbalance.analyzeBalanceImport(c, req.params.id, parsed, fiscalYearId || undefined)));
  }));
  app.post('/api/dossiers/:id/import-balance/commit', h(async (req, res) => {
    const userId = requireUser(req);
    const { csv, lines, fiscalYearId, date, description, createMissing } = req.body ?? {};
    if (!fiscalYearId || !date) { const e: any = new Error('fiscalYearId et date requis'); e.status = 400; throw e; }
    const parsed = Array.isArray(lines) ? lines : importbalance.parseBalanceCsv(String(csv ?? ''));
    res.json(await withUser(userId, (c) => importbalance.commitBalanceImport(c, req.params.id, parsed, { fiscalYearId, date, description, createMissing: !!createMissing })));
  }));

  // --- Pièces justificatives (conservation / GED) ----------------------------
  app.post('/api/dossiers/:id/documents', h(async (req, res) => {
    const userId = requireUser(req);
    const { mimeType, dataBase64, filename, entryId } = req.body ?? {};
    if (!mimeType || !dataBase64) { const e: any = new Error('mimeType et dataBase64 requis'); e.status = 400; throw e; }
    res.status(201).json(await withUser(userId, (c) => documents.saveDocument(c, req.params.id, { mimeType, dataBase64, filename, entryId }, userId)));
  }));
  app.get('/api/dossiers/:id/documents/:docId', h(async (req, res) => {
    const userId = requireUser(req);
    const doc = await withUser(userId, (c) => documents.getDocument(c, req.params.id, req.params.docId));
    res.setHeader('Content-Type', doc.mime);
    res.setHeader('Content-Disposition', `inline; filename="${(doc.filename || 'piece').replace(/[^\w.\-]/g, '_')}"`);
    res.send(doc.buffer);
  }));

  // --- Tableau de bord par entreprise (dossier) ------------------------------
  app.get('/api/dossiers/:id/dashboard', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => dossierDashboard(c, req.params.id, fy)));
  }));

  // --- Écritures récurrentes / abonnements -----------------------------------
  app.get('/api/dossiers/:id/recurring', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => recurring.listTemplates(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/recurring', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => recurring.createTemplate(c, req.params.id, req.body ?? {}, userId)));
  }));
  app.delete('/api/dossiers/:id/recurring/:tid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => recurring.deleteTemplate(c, req.params.id, req.params.tid));
    res.status(204).end();
  }));
  app.post('/api/dossiers/:id/recurring/:tid/active', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => recurring.setActive(c, req.params.id, req.params.tid, !!req.body?.active));
    res.status(204).end();
  }));
  app.post('/api/dossiers/:id/recurring/:tid/generate', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => recurring.generateDue(c, req.params.id, req.params.tid, req.body?.upTo)));
  }));
  app.post('/api/dossiers/:id/recurring-generate', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => recurring.generateAllDue(c, req.params.id, req.body?.upTo)));
  }));

  // --- Journal d'audit (piste d'audit inaltérable) ---------------------------
  app.get('/api/dossiers/:id/audit', h(async (req, res) => {
    const userId = requireUser(req);
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 200;
    res.json(await withUser(userId, (c) => audit.listAudit(c, req.params.id, limit)));
  }));

  // --- Immobilisations & amortissements --------------------------------------
  app.get('/api/dossiers/:id/assets', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => assets.listAssets(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/assets', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => assets.createAsset(c, req.params.id, req.body ?? {}, userId)));
  }));
  app.get('/api/dossiers/:id/assets/:aid', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => assets.assetDetail(c, req.params.id, req.params.aid)));
  }));
  app.delete('/api/dossiers/:id/assets/:aid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => assets.deleteAsset(c, req.params.id, req.params.aid));
    res.status(204).end();
  }));
  app.post('/api/dossiers/:id/assets/:aid/depreciate', h(async (req, res) => {
    const userId = requireUser(req);
    const { periodDate } = req.body ?? {};
    if (!periodDate) { const e: any = new Error('periodDate requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => assets.postDepreciation(c, req.params.id, req.params.aid, String(periodDate))));
  }));
  app.post('/api/dossiers/:id/assets/:aid/depreciate-due', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => assets.postAssetDue(c, req.params.id, req.params.aid, req.body?.upTo)));
  }));
  app.post('/api/dossiers/:id/depreciate-due', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => assets.postDepreciationDue(c, req.params.id, req.body?.upTo)));
  }));
  app.post('/api/dossiers/:id/assets/:aid/dispose', h(async (req, res) => {
    const userId = requireUser(req);
    const { disposalDate, salePrice, cashAccount } = req.body ?? {};
    if (!disposalDate) { const e: any = new Error('disposalDate requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => assets.disposeAsset(c, req.params.id, req.params.aid, { disposalDate, salePrice: Number(salePrice) || 0, cashAccount })));
  }));

  // --- Facturation de vente + FNE --------------------------------------------
  app.get('/api/dossiers/:id/invoices', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => invoicing.listInvoices(c, req.params.id, (req.query.status as string) || undefined, (req.query.docType as string) || undefined)));
  }));
  app.post('/api/dossiers/:id/invoices', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => invoicing.createInvoice(c, req.params.id, req.body ?? {})));
  }));
  app.post('/api/dossiers/:id/invoices/:iid/convert', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => invoicing.convertQuote(c, req.params.id, req.params.iid)));
  }));
  app.post('/api/dossiers/:id/invoices/:iid/credit-note', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => invoicing.creditNoteFromInvoice(c, req.params.id, req.params.iid)));
  }));
  app.get('/api/dossiers/:id/invoices/:iid', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => invoicing.getInvoice(c, req.params.id, req.params.iid)));
  }));
  app.delete('/api/dossiers/:id/invoices/:iid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => invoicing.deleteInvoice(c, req.params.id, req.params.iid));
    res.status(204).end();
  }));
  app.post('/api/dossiers/:id/invoices/:iid/issue', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => invoicing.issueInvoice(c, req.params.id, req.params.iid)));
  }));
  app.post('/api/dossiers/:id/invoices/:iid/certify', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => invoicing.certifyInvoiceFne(c, req.params.id, req.params.iid)));
  }));

  // --- Comptabilité auxiliaire (tiers) ---------------------------------------
  app.get('/api/dossiers/:id/counterparties', h(async (req, res) => {
    const userId = requireUser(req);
    const type = (req.query.type as string) || undefined;
    res.json(await withUser(userId, (c) => tiers.listCounterparties(c, req.params.id, type)));
  }));

  app.post('/api/dossiers/:id/counterparties', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => tiers.createCounterparty(c, req.params.id, req.body ?? {}));
    res.status(201).json(out);
  }));

  app.patch('/api/dossiers/:id/counterparties/:cid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => tiers.updateCounterparty(c, req.params.id, req.params.cid, req.body ?? {}));
    res.status(204).end();
  }));

  app.delete('/api/dossiers/:id/counterparties/:cid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => tiers.deleteCounterparty(c, req.params.id, req.params.cid));
    res.status(204).end();
  }));

  app.get('/api/dossiers/:id/aux-balance', h(async (req, res) => {
    const userId = requireUser(req);
    const type = (req.query.type as string) || undefined;
    res.json(await withUser(userId, (c) => tiers.auxiliaryBalance(c, req.params.id, type)));
  }));

  app.get('/api/dossiers/:id/aux-ledger', h(async (req, res) => {
    const userId = requireUser(req);
    const counterparty = (req.query.counterparty as string) || '';
    if (!counterparty) { const e: any = new Error('counterparty requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => tiers.auxiliaryLedger(c, req.params.id, counterparty)));
  }));

  // --- Rapprochement bancaire (pointage) -------------------------------------
  app.get('/api/dossiers/:id/bank-accounts', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => bank.bankAccounts(c, req.params.id)));
  }));

  app.get('/api/dossiers/:id/reconciliation', h(async (req, res) => {
    const userId = requireUser(req);
    const account = (req.query.account as string) || '';
    if (!account) { const e: any = new Error('account requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => bank.reconciliationView(c, req.params.id, account)));
  }));

  app.post('/api/dossiers/:id/reconciliation/point', h(async (req, res) => {
    const userId = requireUser(req);
    const { entryLineId, pointed } = req.body ?? {};
    await withUser(userId, (c) => bank.setPointing(c, req.params.id, entryLineId, !!pointed));
    res.status(204).end();
  }));

  app.post('/api/dossiers/:id/reconciliation/match', h(async (req, res) => {
    const userId = requireUser(req);
    const { account, csv } = req.body ?? {};
    if (!account || !csv) { const e: any = new Error('account et csv requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => bank.matchStatement(c, req.params.id, account, String(csv))));
  }));
  app.post('/api/dossiers/:id/reconciliation/apply', h(async (req, res) => {
    const userId = requireUser(req);
    const { entryLineIds } = req.body ?? {};
    res.json(await withUser(userId, (c) => bank.applyPointings(c, req.params.id, Array.isArray(entryLineIds) ? entryLineIds : [])));
  }));
  app.post('/api/dossiers/:id/reconciliation/create', h(async (req, res) => {
    const userId = requireUser(req);
    const { account, row, counterAccount } = req.body ?? {};
    if (!account || !row || !counterAccount) { const e: any = new Error('account, row, counterAccount requis'); e.status = 400; throw e; }
    res.status(201).json(await withUser(userId, (c) => bank.createFromStatement(c, req.params.id, account, row, counterAccount)));
  }));

  // --- Lettrage des comptes de tiers -----------------------------------------
  app.get('/api/dossiers/:id/tiers-accounts', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => lettrage.tiersAccounts(c, req.params.id)));
  }));

  app.get('/api/dossiers/:id/lettrage', h(async (req, res) => {
    const userId = requireUser(req);
    const account = (req.query.account as string) || '';
    if (!account) { const e: any = new Error('account requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => lettrage.accountLettrageView(c, req.params.id, account)));
  }));

  app.post('/api/dossiers/:id/lettrage', h(async (req, res) => {
    const userId = requireUser(req);
    const { accountCode, lineIds } = req.body ?? {};
    const out = await withUser(userId, (c) => lettrage.createLettrage(c, req.params.id, accountCode, lineIds));
    res.status(201).json(out);
  }));

  app.delete('/api/dossiers/:id/lettrage/:lettrageId', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => lettrage.deleteLettrage(c, req.params.id, req.params.lettrageId));
    res.status(204).end();
  }));

  app.post('/api/dossiers/:id/lettrage-auto', h(async (req, res) => {
    const userId = requireUser(req);
    const account = (req.body?.accountCode as string) || undefined;
    res.json(await withUser(userId, (c) => lettrage.autoLettrage(c, req.params.id, account)));
  }));

  // --- Relances clients -------------------------------------------------------
  app.get('/api/dossiers/:id/overdue', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => relances.overdueClients(c, req.params.id, (req.query.asOf as string) || undefined)));
  }));
  app.get('/api/dossiers/:id/relance/:cid', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => relances.relanceLetter(c, req.params.id, req.params.cid, (req.query.asOf as string) || undefined)));
  }));
  app.post('/api/dossiers/:id/relance/:cid', h(async (req, res) => {
    const userId = requireUser(req);
    const { level, amount, asOf, note } = req.body ?? {};
    res.status(201).json(await withUser(userId, (c) => relances.recordRelance(c, req.params.id, req.params.cid, Number(level) || 1, Number(amount) || 0, asOf, note)));
  }));

  app.get('/api/dossiers/:id/aged-balance', h(async (req, res) => {
    const userId = requireUser(req);
    const asOf = (req.query.asOf as string) || undefined;
    res.json(await withUser(userId, (c) => lettrage.agedBalance(c, req.params.id, asOf)));
  }));

  app.get('/api/dossiers/:id/journal-entries', h(async (req, res) => {
    const userId = requireUser(req);
    const journal = (req.query.journal as string) || undefined;
    const fiscalYearId = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => acc.journalEntries(c, req.params.id, { journal, fiscalYearId })));
  }));

  app.post('/api/dossiers/:id/close-exercise', h(async (req, res) => {
    const userId = requireUser(req);
    const { fiscalYearId } = req.body ?? {};
    if (!fiscalYearId) { const e: any = new Error('fiscalYearId requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => acc.closeExercise(c, req.params.id, fiscalYearId)));
  }));

  app.get('/api/dossiers/:id/general-ledger', h(async (req, res) => {
    const userId = requireUser(req);
    const fiscalYearId = (req.query.fiscalYearId as string) || undefined;
    const accountCode = (req.query.account as string) || undefined;
    res.json(await withUser(userId, (c) => acc.generalLedger(c, req.params.id, { fiscalYearId, accountCode })));
  }));

  app.get('/api/dossiers/:id/financial-statements', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => acc.financialStatements(c, req.params.id, fy)));
  }));
  app.get('/api/dossiers/:id/financial-statements-comparative', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => acc.financialStatementsComparative(c, req.params.id, fy)));
  }));

  // 404 pour toute route API inconnue
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ressource introuvable' }));

  // Production : sert le front build (dist) + fallback SPA (même origine → /api relatif).
  if (process.env.SERVE_STATIC === 'true') {
    const dist = path.resolve('dist');
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // Filet de sécurité : aucune erreur non gérée ne doit crasher le process
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Erreur non gérée:', err?.message ?? err);
    if (res.headersSent) return;
    res.status(err?.status ?? 500).json({ error: err?.message ?? 'Erreur serveur' });
  });

  return app;
}
