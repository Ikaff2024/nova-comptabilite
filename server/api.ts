import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { withUser, pool } from './db.js';
import * as acc from './domain/accounting.js';
import * as users from './domain/users.js';
import { hashPassword, verifyPassword, issueToken, verifyToken, generateTotpSecret, totpUri, verifyTotp } from './auth.js';
import { extractDocument, aiProvider } from './ai/provider.js';
import * as agent from './ai/agent.js';
import * as whatsapp from './whatsapp/provider.js';
import * as waHandler from './whatsapp/handler.js';
import * as walinks from './domain/whatsapp.js';
import * as telegram from './telegram/provider.js';
import * as tgHandler from './telegram/handler.js';
import * as tglinks from './domain/telegram.js';
import * as tts from './tts/provider.js';
import * as mail from './email/provider.js';
import * as payroll from './domain/payroll.js';
import * as recinv from './domain/recurringinvoices.js';
import * as watchdog from './ai/watchdog.js';
import * as mm from './domain/mobilemoney.js';
import * as lettrage from './domain/lettrage.js';
import * as bank from './domain/bank.js';
import * as tiers from './domain/tiers.js';
import * as invoicing from './domain/invoicing.js';
import * as purchases from './domain/purchases.js';
import * as catalog from './domain/catalog.js';
import * as closures from './domain/closures.js';
import * as tax from './domain/tax.js';
import * as importbalance from './domain/importbalance.js';
import * as assets from './domain/assets.js';
import * as audit from './domain/audit.js';
import * as usage from './domain/usage.js';
import * as platform from './domain/platform.js';
import * as alerts from './domain/alerts.js';
import * as ratios from './domain/ratios.js';
import * as controls from './domain/controls.js';
import * as aqm from './domain/aqm.js';
import * as ledgerDom from './domain/ledger.js';
import { dossierDashboard } from './domain/dossierdashboard.js';
import { fecExport } from './domain/fec.js';
import * as analytic from './domain/analytic.js';
import * as budget from './domain/budget.js';
import * as budgetcopilot from './domain/budgetcopilot.js';
import * as clotureworks from './domain/clotureworks.js';
import * as accdocs from './documents/accounting-docs.js';
import { postCutoff } from './domain/cutoff.js';
import * as obligations from './domain/obligations.js';
import * as entrytemplates from './domain/entrytemplates.js';
import * as revision from './domain/revision.js';
import { cashForecast, echeancier } from './domain/forecast.js';
import { creditScore } from './domain/scoring.js';
import * as financing from './domain/financing.js';
import * as recurring from './domain/recurring.js';
import * as documents from './domain/documents.js';
import * as csv from './documents/csv.js';
import * as portal from './domain/portal.js';
import * as relances from './domain/relances.js';

// ============================================================================
// API HTTP — fine couche au-dessus du domaine. Chaque route s'exécute dans une
// transaction avec l'identité courante (RLS). Aucune SQL ici.
// ============================================================================

export function createApi() {
  const app = express();
  // Conserve le corps brut (nécessaire à la vérif de signature du webhook WhatsApp).
  app.use(express.json({ limit: '15mb', verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

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

  // --- Garde-fou de capacités du portail client ------------------------------
  // Un utilisateur au rôle restreint ('client'/'lecture') sur un dossier ne peut
  // que CONSULTER (GET, déjà borné à son dossier par la RLS) et DÉPOSER une pièce
  // (POST /documents). Toute autre écriture est refusée (allowlist, deny par
  // défaut). Le rôle est calculé côté base (dossier_role_for) à chaque requête.
  // Seul un POST /documents (dépôt de pièce) est autorisé en écriture pour un
  // rôle restreint ; tout le reste des écritures est refusé.
  const clientCanWrite = (method: string, subPath: string): boolean =>
    method === 'POST' && subPath === '/documents';
  app.use('/api/dossiers/:id', (req: any, res: Response, next: NextFunction) => {
    if (!req.userId) return next();                                   // requireUser renverra 401
    if (req.method === 'GET' || req.method === 'HEAD') return next(); // lecture bornée par la RLS
    const dossierId = req.params.id;
    if (!dossierId) return next();
    withUser(req.userId, (c) => portal.myDossierRole(c, dossierId))
      .then((role) => {
        if (portal.isRestricted(role) && !clientCanWrite(req.method, req.path)) {
          return res.status(403).json({ error: 'Accès restreint : votre profil client ne permet pas cette action.', code: 'CLIENT_FORBIDDEN' });
        }
        next();
      })
      .catch(next);
  });

  app.get('/api/health', async (_req, res) => {
    const commit = (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT ?? '').slice(0, 7) || null;
    const base = { agent: agent.agentEnabled(), tts: tts.ttsEnabled(), ttsProviders: tts.providersAvailable(), ttsForced: process.env.TTS_FORCE_PROVIDER || null, telegram: telegram.telegramEnabled(), email: mail.emailEnabled(), commit, service: 'nova-comptabilite-api' };
    try {
      await pool.query('select 1');
      // Diagnostic de schéma : confirme l'application des migrations récentes.
      let schema: Record<string, boolean> = {};
      try {
        const { rows } = await pool.query(
          `select
             (select count(*) from information_schema.tables  where table_schema='public' and table_name='catalog_items')   > 0 as catalog_items,
             (select count(*) from information_schema.tables  where table_schema='public' and table_name='period_closures') > 0 as period_closures,
             (select count(*) from information_schema.tables  where table_schema='public' and table_name='decision_ledger') > 0 as decision_ledger`);
        schema = rows[0] ?? {};
      } catch { /* diagnostic best-effort */ }
      res.json({ ok: true, db: true, ...base, schema });
    } catch { res.status(503).json({ ok: false, db: false, ...base }); }
  });

  // --- Agent nocturne : digest quotidien (déclenché par un cron externe) ------
  app.post('/api/cron/watchdog', h(async (req: any, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.header('x-cron-secret') !== secret) { const e: any = new Error('Non autorisé'); e.status = 401; throw e; }
    res.json(await watchdog.runDailyPush());
  }));

  // --- Webhook WhatsApp (Meta Cloud API) — non authentifié (appelé par Meta) --
  app.get('/api/whatsapp/webhook', (req, res) => {
    if (whatsapp.verifyWebhook(String(req.query['hub.mode'] ?? ''), String(req.query['hub.verify_token'] ?? '')))
      return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    res.sendStatus(403);
  });
  app.post('/api/whatsapp/webhook', (req: any, res) => {
    if (!whatsapp.verifySignature(req.rawBody ?? '', req.header('x-hub-signature-256'))) return res.sendStatus(401);
    res.sendStatus(200); // accusé rapide exigé par Meta ; traitement en arrière-plan
    const msgs = whatsapp.parseInbound(req.body);
    if (msgs.length) waHandler.handleInbound(msgs).catch(() => {});
  });

  // --- Webhook Telegram (Bot API) — non authentifié (appelé par Telegram) ----
  app.post('/api/telegram/webhook', (req: any, res) => {
    if (!telegram.verifySecret(req.header('x-telegram-bot-api-secret-token'))) return res.sendStatus(401);
    res.sendStatus(200);
    const up = telegram.parseUpdate(req.body);
    if (up) tgHandler.handleUpdate(up).catch(() => {});
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
    res.json({ token, user: { id: row.id, email: row.email, name: row.name, twoFactorEnabled: row.totp_enabled, platformAdmin: !!row.is_platform_admin } });
  }));

  app.get('/api/auth/me', h(async (req, res) => {
    const userId = requireUser(req);
    const user = await withUser(userId, (c) => users.getUser(c, userId));
    if (!user) { const e: any = new Error('Utilisateur introuvable'); e.status = 404; throw e; }
    res.json({ id: user.id, email: user.email, name: user.name, twoFactorEnabled: user.totp_enabled, platformAdmin: !!user.is_platform_admin });
  }));

  app.patch('/api/auth/me', h(async (req, res) => {
    const userId = requireUser(req);
    const { name } = req.body ?? {};
    if (!name?.trim()) { const e: any = new Error('Nom requis'); e.status = 400; throw e; }
    await withUser(userId, (c) => users.setMyName(c, String(name)));
    res.status(204).end();
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

  // --- Cabinet : renommage ---------------------------------------------------
  app.patch('/api/cabinets/:cid', h(async (req, res) => {
    const userId = requireUser(req);
    const { name } = req.body ?? {};
    if (!name?.trim()) { const e: any = new Error('Nom requis'); e.status = 400; throw e; }
    await withUser(userId, (c) => users.renameCabinet(c, req.params.cid, String(name)));
    res.status(204).end();
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

  // Suivi des coûts d'API par client (page propriétaire). Portée RLS = dossiers accessibles.
  app.get('/api/usage', h(async (req, res) => {
    const userId = requireUser(req);
    const days = Math.min(365, Math.max(1, Number(req.query?.days) || 30));
    res.json(await withUser(userId, (c) => usage.usageSummary(c, days)));
  }));

  // Console éditeur Nova : vue transverse à tous les cabinets clients.
  // La fonction SQL est fail-closed ; on mappe l'exception en 403.
  app.get('/api/platform/overview', h(async (req, res) => {
    const userId = requireUser(req);
    try {
      res.json(await withUser(userId, (c) => platform.platformOverview(c)));
    } catch (e: any) {
      if (String(e?.message ?? '').includes('NOT_PLATFORM_ADMIN')) { const err: any = new Error('Accès réservé aux opérateurs Nova'); err.status = 403; throw err; }
      throw e;
    }
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
    const includeInactive = req.query.all === '1';
    res.json(await withUser(userId, (c) => acc.listAccounts(c, req.params.id, { classNo, search, includeInactive })));
  }));
  app.post('/api/dossiers/:id/accounts', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => acc.createAccount(c, req.params.id, req.body ?? {})));
  }));
  app.patch('/api/dossiers/:id/accounts/:accId', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => acc.updateAccount(c, req.params.id, req.params.accId, req.body ?? {}));
    res.status(204).end();
  }));
  app.delete('/api/dossiers/:id/accounts/:accId', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => acc.deleteAccount(c, req.params.id, req.params.accId));
    res.status(204).end();
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

  // Travaux de fin d'exercice : checklist de contrôle du grand livre.
  app.get('/api/dossiers/:id/cloture-works', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => clotureworks.clotureChecklist(c, req.params.id, (req.query.fiscalYearId as string) || undefined)));
  }));

  // --- Clôtures mensuelles (verrouillage de période) --------------------------
  app.get('/api/dossiers/:id/closures', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => closures.listClosures(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/closures', h(async (req, res) => {
    const userId = requireUser(req);
    const { year, month } = req.body ?? {};
    if (!year || !month) { const e: any = new Error('year et month requis'); e.status = 400; throw e; }
    await withUser(userId, (c) => closures.closePeriod(c, req.params.id, Number(year), Number(month), userId));
    res.status(201).end();
  }));
  app.delete('/api/dossiers/:id/closures/:year/:month', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => closures.reopenPeriod(c, req.params.id, Number(req.params.year), Number(req.params.month)));
    res.status(204).end();
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
        context: { country: dossier.country, currency: dossier.base_currency, accountingSystem: dossier.accounting_system, companyName: dossier.raison_sociale, mappings, rules, chart },
      });

      // Contrôle destinataire : signale (sans bloquer) une pièce qui ne semble
      // pas au nom de l'entreprise. Repli serveur si l'IA n'a pas levé le warning.
      const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(sarl|suarl|sa|sas|sci|ei|entreprise|ets|etablissements?|societe|ste)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      if (p.recipientName && dossier.raison_sociale) {
        const rn = norm(p.recipientName), cn = norm(dossier.raison_sociale);
        const matches = rn && cn && (rn.includes(cn) || cn.includes(rn) || rn.split(' ').some((w) => w.length > 3 && cn.includes(w)));
        const already = (p.warnings ?? []).some((w) => /nom|destinataire|adress/i.test(w));
        if (!matches && !already) {
          p.warnings = [...(p.warnings ?? []), `Pièce au nom de « ${p.recipientName} », pas de « ${dossier.raison_sociale} » — à vérifier (elle ne concerne peut-être pas l'entreprise).`];
        }
      }

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

  // AQM — contrôle qualité déterministe d'une écriture proposée (avant comptabilisation).
  app.post('/api/dossiers/:id/validate-entry', h(async (req, res) => {
    const userId = requireUser(req);
    const b = req.body ?? {};
    const draft = {
      date: b.entryDate || b.date || undefined,
      journalCode: b.journalCode,
      lines: Array.isArray(b.lines) ? b.lines.map((l: any) => ({ accountCode: String(l.accountCode ?? l.compte ?? '').trim(), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, label: l.label })) : [],
    };
    res.json(await withUser(userId, (c) => aqm.validateEntry(c, req.params.id, draft, { fiscalYearId: b.fiscalYearId })));
  }));

  // AQM — contrôle qualité d'une facture proposée (vente/achat) avant établissement.
  app.post('/api/dossiers/:id/validate-invoice', h(async (req, res) => {
    const userId = requireUser(req);
    const b = req.body ?? {};
    const draft = {
      type: (b.type === 'achat' ? 'achat' : 'vente') as 'vente' | 'achat',
      date: b.date || b.invoiceDate || undefined,
      dueDate: b.dueDate || b.echeance || undefined,
      tiers: b.tiers || b.clientName || b.supplierName || undefined,
      lines: Array.isArray(b.lines) ? b.lines.map((l: any) => ({ description: l.description, quantity: Number(l.quantity) || 0, unitPrice: Number(l.unitPrice ?? l.unit_price) || 0, vatRate: Number(l.vatRate ?? l.vat_rate) || 0, accountCode: String(l.accountCode ?? l.account_code ?? '').trim() })) : [],
    };
    res.json(await withUser(userId, (c) => aqm.validateInvoice(c, req.params.id, draft)));
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
  // Récapitulatif annuel de TVA (12 mois) — PDF.
  app.get('/api/dossiers/:id/vat/recap', h(async (req, res) => {
    const userId = requireUser(req);
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const out = await withUser(userId, (c) => accdocs.recapTvaAnnuelPdf(c, req.params.id, year));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
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
    const { csv, lines, fiscalYearId, date, description, createMissing, tiersCsv, tiersItems } = req.body ?? {};
    if (!fiscalYearId || !date) { const e: any = new Error('fiscalYearId et date requis'); e.status = 400; throw e; }
    const parsed = Array.isArray(lines) ? lines : importbalance.parseBalanceCsv(String(csv ?? ''));
    const items = Array.isArray(tiersItems) ? tiersItems : (tiersCsv ? importbalance.parseTiersCsv(String(tiersCsv)) : undefined);
    res.json(await withUser(userId, (c) => importbalance.commitBalanceImport(c, req.params.id, parsed, { fiscalYearId, date, description, createMissing: !!createMissing, tiersItems: items })));
  }));
  app.post('/api/dossiers/:id/import-balance/parse-tiers', h(async (req, res) => {
    requireUser(req);
    const items = importbalance.parseTiersCsv(String(req.body?.tiersCsv ?? ''));
    res.json({ count: items.length, items });
  }));

  // --- Portail client : rôle effectif + gestion des accès --------------------
  app.get('/api/dossiers/:id/my-role', h(async (req, res) => {
    const userId = requireUser(req);
    const role = await withUser(userId, (c) => portal.myDossierRole(c, req.params.id));
    res.json({ role });
  }));
  app.get('/api/dossiers/:id/clients', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => portal.listClients(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/clients', h(async (req, res) => {
    const userId = requireUser(req);
    const { email } = req.body ?? {};
    res.status(201).json(await withUser(userId, (c) => portal.grantClient(c, req.params.id, email)));
  }));
  app.delete('/api/dossiers/:id/clients/:uid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => portal.revokeClient(c, req.params.id, req.params.uid));
    res.status(204).end();
  }));

  // --- Pièces justificatives (conservation / GED) ----------------------------
  app.get('/api/dossiers/:id/documents', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => documents.listDocuments(c, req.params.id)));
  }));
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

  // Alertes intelligentes (points d'attention priorisés) du dossier.
  app.get('/api/dossiers/:id/alerts', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => alerts.dossierAlerts(c, req.params.id, fy)));
  }));

  // Ratios & analyse financière du dossier.
  app.get('/api/dossiers/:id/ratios', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => ratios.financialRatios(c, req.params.id, fy)));
  }));

  // Contrôles de cohérence comptable (révision automatisée).
  app.get('/api/dossiers/:id/controls', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => controls.coherenceChecks(c, req.params.id, fy)));
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
  // État des immobilisations (registre brut/amort./VNC) en PDF.
  app.get('/api/dossiers/:id/assets-register', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, async (c) => {
      const ds = await acc.listDossiers(c);
      const cur = ds.find((d: any) => d.id === req.params.id)?.base_currency ?? 'XOF';
      return assets.assetsRegisterPdf(c, req.params.id, cur);
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
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
  // --- Catalogue des articles/services vendus ---------------------------------
  app.get('/api/dossiers/:id/catalog', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => catalog.listCatalog(c, req.params.id, req.query.all === '1')));
  }));
  app.post('/api/dossiers/:id/catalog', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => catalog.createCatalogItem(c, req.params.id, req.body ?? {})));
  }));
  app.patch('/api/dossiers/:id/catalog/:cid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => catalog.updateCatalogItem(c, req.params.id, req.params.cid, req.body ?? {}));
    res.status(204).end();
  }));
  app.delete('/api/dossiers/:id/catalog/:cid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => catalog.deleteCatalogItem(c, req.params.id, req.params.cid));
    res.status(204).end();
  }));

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

  // --- Cycle achats fournisseurs ---------------------------------------------
  app.get('/api/dossiers/:id/purchases', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => purchases.listPurchases(c, req.params.id, (req.query.status as string) || undefined)));
  }));
  app.post('/api/dossiers/:id/purchases', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => purchases.createPurchase(c, req.params.id, req.body ?? {})));
  }));
  app.get('/api/dossiers/:id/purchases/aging', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => purchases.supplierAging(c, req.params.id, (req.query.asOf as string) || undefined)));
  }));
  // Vérifie si une facture ressemble à une déjà saisie (avant enregistrement).
  app.post('/api/dossiers/:id/purchases/check-duplicate', h(async (req, res) => {
    const userId = requireUser(req);
    const { supplierName, supplierRef, invoiceDate, totalTtc, excludeId } = req.body ?? {};
    const duplicates = await withUser(userId, (c) => purchases.findPurchaseDuplicates(c, req.params.id, { supplierName, supplierRef, invoiceDate, totalTtc, excludeId }));
    res.json({ duplicates });
  }));
  app.get('/api/dossiers/:id/purchases/:pid', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => purchases.getPurchase(c, req.params.id, req.params.pid)));
  }));
  app.delete('/api/dossiers/:id/purchases/:pid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => purchases.deletePurchase(c, req.params.id, req.params.pid));
    res.status(204).end();
  }));
  app.post('/api/dossiers/:id/purchases/:pid/record', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => purchases.recordPurchase(c, req.params.id, req.params.pid)));
  }));
  app.post('/api/dossiers/:id/purchases/:pid/pay', h(async (req, res) => {
    const userId = requireUser(req);
    const { paymentDate, treasuryCode, channel } = req.body ?? {};
    res.json(await withUser(userId, (c) => purchases.payPurchase(c, req.params.id, req.params.pid, { paymentDate, treasuryCode, channel })));
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
  // Relevé de compte d'un tiers, en PDF (état de compte pour le recouvrement).
  app.get('/api/dossiers/:id/tiers/:cid/statement', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, async (c) => {
      const ds = await acc.listDossiers(c);
      const cur = ds.find((d: any) => d.id === req.params.id)?.base_currency ?? 'XOF';
      return tiers.tiersStatementPdf(c, req.params.id, req.params.cid, cur);
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));
  app.get('/api/dossiers/:id/tiers/:cid/balance-letter', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, async (c) => {
      const ds = await acc.listDossiers(c);
      const cur = ds.find((d: any) => d.id === req.params.id)?.base_currency ?? 'XOF';
      return tiers.tiersBalanceLetterPdf(c, req.params.id, req.params.cid, cur);
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));
  // Livre-journal (journal général chronologique) — livre légal OHADA, en PDF.
  app.get('/api/dossiers/:id/livre-journal', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => accdocs.livreJournalPdf(c, req.params.id, (req.query.fiscalYearId as string) || undefined));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));

  app.get('/api/dossiers/:id/grand-livre-general', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => accdocs.grandLivreGeneralPdf(c, req.params.id, (req.query.fiscalYearId as string) || undefined));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));

  app.get('/api/dossiers/:id/journal-centralisateur', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => accdocs.journalCentralisateurPdf(c, req.params.id, (req.query.fiscalYearId as string) || undefined));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));

  app.get('/api/dossiers/:id/balance-auxiliaire', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => accdocs.balanceAuxiliairePdf(c, req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));

  app.get('/api/dossiers/:id/grand-livre-auxiliaire', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => accdocs.grandLivreAuxiliairePdf(c, req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
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
  app.get('/api/dossiers/:id/reconciliation-statement', h(async (req, res) => {
    const userId = requireUser(req);
    const account = (req.query.account as string) || '';
    if (!account) { const e: any = new Error('account requis'); e.status = 400; throw e; }
    const out = await withUser(userId, async (c) => {
      const ds = await acc.listDossiers(c);
      const cur = ds.find((d: any) => d.id === req.params.id)?.base_currency ?? 'XOF';
      return bank.reconciliationStatementPdf(c, req.params.id, account, cur);
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
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
    const { account, row, counterAccount, counterAxis } = req.body ?? {};
    if (!account || !row || !counterAccount) { const e: any = new Error('account, row, counterAccount requis'); e.status = 400; throw e; }
    res.status(201).json(await withUser(userId, (c) => bank.createFromStatement(c, req.params.id, account, row, counterAccount, counterAxis)));
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

  // Estimation de l'impôt sur les bénéfices (IS) & IMF — barème Côte d'Ivoire.
  app.get('/api/dossiers/:id/is-estimate', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => tax.estimationIS(c, req.params.id, fy)));
  }));

  // Exports tableur (Excel/LibreOffice) : balance & grand livre en CSV.
  app.get('/api/dossiers/:id/export/balance.csv', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    const out = await withUser(userId, (c) => csv.balanceCsv(c, req.params.id, fy));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));
  app.get('/api/dossiers/:id/export/grand-livre.csv', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    const account = (req.query.account as string) || '';
    if (!account) { const e: any = new Error('Paramètre account requis'); e.status = 400; throw e; }
    const out = await withUser(userId, (c) => csv.grandLivreCsv(c, req.params.id, account, fy));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));
  // --- Scoring & finance embarquée -------------------------------------------
  app.get('/api/dossiers/:id/score', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => creditScore(c, req.params.id, fy)));
  }));
  app.get('/api/dossiers/:id/financing', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => financing.listRequests(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/financing/request', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => financing.requestAdvance(c, req.params.id, Number(req.body?.amount) || 0)));
  }));
  app.post('/api/dossiers/:id/financing/:fid/decide', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => financing.decideRequest(c, req.params.id, req.params.fid, !!req.body?.approve, req.body?.note));
    res.status(204).end();
  }));
  app.post('/api/dossiers/:id/financing/:fid/disburse', h(async (req, res) => {
    const userId = requireUser(req);
    const { date, bankAccount } = req.body ?? {};
    if (!date) { const e: any = new Error('date requise'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => financing.disburse(c, req.params.id, req.params.fid, date, bankAccount || '521')));
  }));
  app.post('/api/dossiers/:id/financing/:fid/repay', h(async (req, res) => {
    const userId = requireUser(req);
    const { date, amount, interest, bankAccount } = req.body ?? {};
    if (!date || !amount) { const e: any = new Error('date et amount requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => financing.repay(c, req.params.id, req.params.fid, date, Number(amount), Number(interest) || 0, bankAccount || '521')));
  }));

  // --- Prévisionnel de trésorerie --------------------------------------------
  app.get('/api/dossiers/:id/cash-forecast', h(async (req, res) => {
    const userId = requireUser(req);
    const horizonWeeks = req.query.weeks ? Number(req.query.weeks) : undefined;
    const delayDays = req.query.delay ? Number(req.query.delay) : undefined;
    res.json(await withUser(userId, (c) => cashForecast(c, req.params.id, { horizonWeeks, delayDays })));
  }));
  app.get('/api/dossiers/:id/echeancier', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => echeancier(c, req.params.id)));
  }));

  // Balance âgée des tiers (antériorité des créances / dettes) — PDF.
  app.get('/api/dossiers/:id/balance-agee', h(async (req, res) => {
    const userId = requireUser(req);
    const out = await withUser(userId, (c) => accdocs.balanceAgeePdf(c, req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));

  // --- Dossier de révision (justification des comptes) -----------------------
  app.get('/api/dossiers/:id/revision', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || '';
    if (!fy) { const e: any = new Error('fiscalYearId requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => revision.revisionReport(c, req.params.id, fy)));
  }));
  app.post('/api/dossiers/:id/revision', h(async (req, res) => {
    const userId = requireUser(req);
    const { fiscalYearId, accountCode, status, note } = req.body ?? {};
    if (!fiscalYearId || !accountCode) { const e: any = new Error('fiscalYearId et accountCode requis'); e.status = 400; throw e; }
    await withUser(userId, (c) => revision.setReview(c, req.params.id, fiscalYearId, accountCode, { status, note }));
    res.status(204).end();
  }));

  // --- Modèles de saisie -----------------------------------------------------
  app.get('/api/dossiers/:id/entry-templates', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => entrytemplates.listTemplates(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/entry-templates', h(async (req, res) => {
    const userId = requireUser(req);
    const { name, journalCode, lines } = req.body ?? {};
    res.status(201).json(await withUser(userId, (c) => entrytemplates.createTemplate(c, req.params.id, name, journalCode ?? null, lines ?? [])));
  }));
  app.delete('/api/dossiers/:id/entry-templates/:tid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => entrytemplates.deleteTemplate(c, req.params.id, req.params.tid));
    res.status(204).end();
  }));

  // --- Échéancier des obligations --------------------------------------------
  app.get('/api/dossiers/:id/obligations', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => obligations.listObligations(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/obligations', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => obligations.createObligation(c, req.params.id, req.body ?? {})));
  }));
  app.post('/api/dossiers/:id/obligations/seed', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => obligations.seedDefaults(c, req.params.id)));
  }));
  app.delete('/api/dossiers/:id/obligations/:oid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => obligations.deleteObligation(c, req.params.id, req.params.oid));
    res.status(204).end();
  }));

  // --- Régularisations de cut-off (CCA/PCA/FNP/FAE) --------------------------
  app.post('/api/dossiers/:id/cutoff', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => postCutoff(c, req.params.id, req.body ?? {})));
  }));

  // --- Budgets ---------------------------------------------------------------
  app.get('/api/dossiers/:id/budget', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || '';
    if (!fy) { const e: any = new Error('fiscalYearId requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => budget.budgetReport(c, req.params.id, fy)));
  }));
  // Forecast glissant : réel à date + projection fin d'année (run-rate).
  app.get('/api/dossiers/:id/budget/forecast', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || '';
    if (!fy) { const e: any = new Error('fiscalYearId requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => budget.rollingForecast(c, req.params.id, fy, (req.query.asOf as string) || undefined)));
  }));
  // Copilote budgétaire — génération depuis l'historique (Phase 2).
  app.get('/api/dossiers/:id/budget/generate', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || '';
    if (!fy) { const e: any = new Error('fiscalYearId requis'); e.status = 400; throw e; }
    const a = { growthProduits: req.query.growthProduits != null ? Number(req.query.growthProduits) : undefined, inflationCharges: req.query.inflationCharges != null ? Number(req.query.inflationCharges) : undefined };
    res.json(await withUser(userId, (c) => budgetcopilot.generateBudgetFromHistory(c, req.params.id, fy, a)));
  }));
  // Applique un budget proposé (écrit les montants retenus dans budgets).
  app.post('/api/dossiers/:id/budget/apply', h(async (req, res) => {
    const userId = requireUser(req);
    const { fiscalYearId, lines } = req.body ?? {};
    if (!fiscalYearId || !Array.isArray(lines)) { const e: any = new Error('fiscalYearId et lines requis'); e.status = 400; throw e; }
    await withUser(userId, async (c) => {
      for (const l of lines) if (l?.accountCode) await budget.setBudget(c, req.params.id, fiscalYearId, String(l.accountCode).trim(), Number(l.amount) || 0);
    });
    res.json({ applied: lines.length });
  }));
  // Comparaison de scénarios (Phase 3).
  app.get('/api/dossiers/:id/budget/scenarios', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || '';
    if (!fy) { const e: any = new Error('fiscalYearId requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => budgetcopilot.compareScenarios(c, req.params.id, fy)));
  }));
  // États prévisionnels + trésorerie mensuelle + stress test (Phase 4).
  app.get('/api/dossiers/:id/budget/provisional', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || '';
    if (!fy) { const e: any = new Error('fiscalYearId requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => budgetcopilot.provisionalStatements(c, req.params.id, fy, (req.query.scenario as string) || 'central', Number(req.query.stress) || 0)));
  }));
  app.post('/api/dossiers/:id/budget', h(async (req, res) => {
    const userId = requireUser(req);
    const { fiscalYearId, accountCode, amount } = req.body ?? {};
    if (!fiscalYearId || !accountCode) { const e: any = new Error('fiscalYearId et accountCode requis'); e.status = 400; throw e; }
    await withUser(userId, (c) => budget.setBudget(c, req.params.id, fiscalYearId, accountCode, Number(amount) || 0));
    res.status(204).end();
  }));
  app.post('/api/dossiers/:id/budget/import', h(async (req, res) => {
    const userId = requireUser(req);
    const { fiscalYearId, csv, lines } = req.body ?? {};
    if (!fiscalYearId) { const e: any = new Error('fiscalYearId requis'); e.status = 400; throw e; }
    const parsed = Array.isArray(lines) ? lines : budget.parseBudgetCsv(String(csv ?? ''));
    res.json(await withUser(userId, (c) => budget.importBudget(c, req.params.id, fiscalYearId, parsed)));
  }));
  app.delete('/api/dossiers/:id/budget', h(async (req, res) => {
    const userId = requireUser(req);
    const { fiscalYearId, accountCode } = req.body ?? {};
    await withUser(userId, (c) => budget.deleteBudget(c, req.params.id, fiscalYearId, accountCode));
    res.status(204).end();
  }));

  // --- Comptabilité analytique ----------------------------------------------
  app.get('/api/dossiers/:id/analytic/sections', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => analytic.listSections(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/analytic/sections', h(async (req, res) => {
    const userId = requireUser(req);
    const { code, label } = req.body ?? {};
    res.status(201).json(await withUser(userId, (c) => analytic.createSection(c, req.params.id, code, label)));
  }));
  app.delete('/api/dossiers/:id/analytic/sections/:sid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => analytic.deleteSection(c, req.params.id, req.params.sid));
    res.status(204).end();
  }));
  app.get('/api/dossiers/:id/analytic/report', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => analytic.analyticReport(c, req.params.id, fy)));
  }));
  app.get('/api/dossiers/:id/analytic/detail', h(async (req, res) => {
    const userId = requireUser(req);
    const section = (req.query.section as string) || '—';
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => analytic.analyticDetail(c, req.params.id, section, fy)));
  }));
  app.get('/api/dossiers/:id/analytic/monthly', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => analytic.analyticMonthly(c, req.params.id, fy)));
  }));

  // --- Assistant comptable agentique (lecture seule) -------------------------
  app.get('/api/dossiers/:id/agent/status', h(async (req, res) => {
    const userId = requireUser(req);
    const { mode, canToggle, voice } = await withUser(userId, async (c) => ({
      mode: await agent.getAgentMode(c, req.params.id),
      canToggle: await agent.isDossierAdmin(c, req.params.id),
      voice: await agent.getVoice(c, req.params.id),
    }));
    res.json({
      enabled: agent.agentEnabled(), mode, canToggle, tts: tts.ttsEnabled(),
      voice: { provider: voice.provider, voiceId: voice.voiceId, providers: tts.providersAvailable(), catalog: tts.VOICE_CATALOG },
    });
  }));

  // Choix de la voix (fournisseur + voix), réservé au propriétaire/associé.
  app.patch('/api/dossiers/:id/lexa/voice', h(async (req: any, res) => {
    const userId = requireUser(req);
    const { provider, voiceId } = req.body ?? {};
    if (provider != null && !['elevenlabs', 'openai', 'xai'].includes(provider)) { const e: any = new Error('Fournisseur invalide'); e.status = 400; throw e; }
    await withUser(userId, (c) => agent.setVoice(c, req.params.id, provider ?? null, voiceId ?? null));
    res.json(await withUser(userId, (c) => agent.getVoice(c, req.params.id)));
  }));

  // Synthèse vocale serveur (fournisseur/voix du dossier). MP3 ; 204 si indisponible
  // (le front bascule alors sur la voix du navigateur).
  app.post('/api/dossiers/:id/lexa/speak', h(async (req: any, res) => {
    const userId = requireUser(req);
    const text = String(req.body?.text ?? '');
    if (!text.trim()) { res.status(400).json({ error: 'Texte requis' }); return; }
    const v = await withUser(userId, (c) => agent.getVoice(c, req.params.id));
    const audio = await tts.synthesize(text, v.provider as any, v.voiceId || undefined);
    if (!audio) { res.status(204).end(); return; }
    const ttsProvider = v.provider === 'openai' ? 'openai_tts' : 'elevenlabs';
    await withUser(userId, (c) => usage.recordUsage(c, req.params.id, ttsProvider, v.voiceId || null, { units: text.length }));
    res.setHeader('content-type', 'audio/mpeg');
    res.send(audio);
  }));
  app.post('/api/dossiers/:id/agent/mode', h(async (req, res) => {
    const userId = requireUser(req);
    const mode = req.body?.mode;
    if (mode !== 'readonly' && mode !== 'assist' && mode !== 'assist_plus') { const e: any = new Error('mode invalide (readonly|assist|assist_plus)'); e.status = 400; throw e; }
    await withUser(userId, (c) => agent.setAgentMode(c, req.params.id, mode));
    await withUser(userId, (c) => audit.recordAudit(c, { dossierId: req.params.id, action: 'agent.mode_changed', entity: 'agent', detail: { mode } }));
    res.json({ mode });
  }));

  // --- Mémoire de Lexa (auto-apprentissage) ----------------------------------
  app.get('/api/dossiers/:id/lexa/memory', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => agent.listMemories(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/lexa/memory', h(async (req, res) => {
    const userId = requireUser(req);
    const { content } = req.body ?? {};
    res.status(201).json(await withUser(userId, (c) => agent.addMemory(c, req.params.id, content, 'user')));
  }));
  app.delete('/api/dossiers/:id/lexa/memory/:mid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => agent.deleteMemory(c, req.params.id, req.params.mid));
    res.status(204).end();
  }));

  // --- Canal WhatsApp : liaison des numéros au dossier -----------------------
  app.get('/api/dossiers/:id/whatsapp/links', h(async (req, res) => {
    const userId = requireUser(req);
    res.json({ enabled: whatsapp.whatsappEnabled(), links: await withUser(userId, (c) => walinks.listLinks(c, req.params.id)) });
  }));
  app.post('/api/dossiers/:id/whatsapp/links', h(async (req, res) => {
    const userId = requireUser(req);
    const { phone, label } = req.body ?? {};
    if (!phone) { const e: any = new Error('Numéro requis'); e.status = 400; throw e; }
    res.status(201).json(await withUser(userId, (c) => walinks.createLink(c, req.params.id, userId, phone, label)));
  }));
  app.delete('/api/dossiers/:id/whatsapp/links/:lid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => walinks.deleteLink(c, req.params.id, req.params.lid));
    res.status(204).end();
  }));

  // --- Telegram : liaison des chats par code ---------------------------------
  app.get('/api/dossiers/:id/telegram/links', h(async (req, res) => {
    const userId = requireUser(req);
    res.json({ enabled: telegram.telegramEnabled(), links: await withUser(userId, (c) => tglinks.listLinks(c, req.params.id)) });
  }));
  app.post('/api/dossiers/:id/telegram/links', h(async (req, res) => {
    const userId = requireUser(req);
    const { label } = req.body ?? {};
    res.status(201).json(await withUser(userId, (c) => tglinks.createLinkCode(c, req.params.id, userId, label)));
  }));
  app.delete('/api/dossiers/:id/telegram/links/:lid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => tglinks.deleteLink(c, req.params.id, req.params.lid));
    res.status(204).end();
  }));

  // --- Paie : salariés + bulletins -------------------------------------------
  app.get('/api/dossiers/:id/payroll/employees', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => payroll.listEmployees(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/payroll/employees', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => payroll.createEmployee(c, req.params.id, req.body ?? {})));
  }));
  app.patch('/api/dossiers/:id/payroll/employees/:eid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => payroll.updateEmployee(c, req.params.id, req.params.eid, req.body ?? {}));
    res.status(204).end();
  }));
  app.delete('/api/dossiers/:id/payroll/employees/:eid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => payroll.deleteEmployee(c, req.params.id, req.params.eid));
    res.status(204).end();
  }));
  app.get('/api/dossiers/:id/payroll/payslips', h(async (req, res) => {
    const userId = requireUser(req);
    const year = Number(req.query.year), month = Number(req.query.month);
    res.json(await withUser(userId, (c) => payroll.listPayslips(c, req.params.id, year, month)));
  }));
  app.post('/api/dossiers/:id/payroll/run', h(async (req, res) => {
    const userId = requireUser(req);
    const { year, month, varsMap } = req.body ?? {};
    res.json(await withUser(userId, (c) => payroll.runPayroll(c, req.params.id, Number(year), Number(month), varsMap ?? {})));
  }));
  app.post('/api/dossiers/:id/payroll/post', h(async (req, res) => {
    const userId = requireUser(req);
    const { year, month, entryDate } = req.body ?? {};
    res.json(await withUser(userId, (c) => payroll.postPayroll(c, req.params.id, Number(year), Number(month), entryDate || undefined)));
  }));
  app.get('/api/dossiers/:id/payroll/year', h(async (req, res) => {
    const userId = requireUser(req);
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    res.json(await withUser(userId, (c) => payroll.payrollYear(c, req.params.id, year)));
  }));
  // Documents de paie en PDF (téléchargement). kind = ordre_virement | livre_paie.
  app.get('/api/dossiers/:id/payroll/document', h(async (req, res) => {
    const userId = requireUser(req);
    const kind = String(req.query.kind ?? '');
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const month = Math.max(0, Math.min(11, Number(req.query.month) || 0));
    const out = await withUser(userId, (c) => {
      if (kind === 'ordre_virement') return payroll.ordreVirementPdf(c, req.params.id, year, month);
      if (kind === 'courrier_virement') return payroll.courrierVirementPdf(c, req.params.id, year, month);
      if (kind === 'livre_paie') return payroll.livrePaiePdf(c, req.params.id, year, month);
      const e: any = new Error('Type de document inconnu'); e.status = 400; throw e;
    });
    if (out.count === 0) { const e: any = new Error(`Aucun bulletin pour ${month + 1}/${year}`); e.status = 400; throw e; }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));
  // Factures de vente récurrentes (abonnements)
  app.get('/api/dossiers/:id/recurring-invoices', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => recinv.listTemplates(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/recurring-invoices', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => recinv.createTemplate(c, req.params.id, req.body ?? {})));
  }));
  app.patch('/api/dossiers/:id/recurring-invoices/:tid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => recinv.setActive(c, req.params.id, req.params.tid, !!req.body?.active));
    res.status(204).end();
  }));
  app.delete('/api/dossiers/:id/recurring-invoices/:tid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => recinv.deleteTemplate(c, req.params.id, req.params.tid));
    res.status(204).end();
  }));
  app.post('/api/dossiers/:id/recurring-invoices/generate', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => recinv.generateAllDue(c, req.params.id)));
  }));
  // RH : absences
  app.get('/api/dossiers/:id/payroll/absences', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => payroll.listAbsences(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/payroll/absences', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => payroll.createAbsence(c, req.params.id, req.body ?? {})));
  }));
  app.delete('/api/dossiers/:id/payroll/absences/:aid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => payroll.deleteAbsence(c, req.params.id, req.params.aid));
    res.status(204).end();
  }));
  // RH : avances & prêts
  app.get('/api/dossiers/:id/payroll/advances', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => payroll.listAdvances(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/payroll/advances', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => payroll.createAdvance(c, req.params.id, req.body ?? {})));
  }));
  app.delete('/api/dossiers/:id/payroll/advances/:aid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => payroll.deleteAdvance(c, req.params.id, req.params.aid));
    res.status(204).end();
  }));
  // RH : pointage (heures)
  app.get('/api/dossiers/:id/payroll/time', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => payroll.listTimeEntries(c, req.params.id)));
  }));
  app.post('/api/dossiers/:id/payroll/time', h(async (req, res) => {
    const userId = requireUser(req);
    res.status(201).json(await withUser(userId, (c) => payroll.createTimeEntry(c, req.params.id, req.body ?? {})));
  }));
  app.delete('/api/dossiers/:id/payroll/time/:tid', h(async (req, res) => {
    const userId = requireUser(req);
    await withUser(userId, (c) => payroll.deleteTimeEntry(c, req.params.id, req.params.tid));
    res.status(204).end();
  }));
  // RH : solde de tout compte (calcul à la demande)
  app.post('/api/dossiers/:id/payroll/stc', h(async (req, res) => {
    const userId = requireUser(req);
    const b = req.body ?? {};
    if (!b.employeeId || !b.ruptureType || !b.ruptureDate) { const e: any = new Error('Salarié, type et date de rupture requis'); e.status = 400; throw e; }
    res.json(await withUser(userId, (c) => payroll.runSTC(c, req.params.id, b)));
  }));
  app.post('/api/dossiers/:id/agent/chat', h(async (req, res) => {
    const userId = requireUser(req);
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length === 0) { const e: any = new Error('messages requis'); e.status = 400; throw e; }
    const out = await withUser(userId, (c) => agent.runAgent(c, req.params.id, messages, userId));
    const lastUser = String(messages[messages.length - 1]?.content ?? '');
    await withUser(userId, async (c) => {
      await agent.saveTurns(c, req.params.id, userId, [{ role: 'user', content: lastUser }, { role: 'assistant', content: out.reply }]);
      await audit.recordAudit(c, { dossierId: req.params.id, action: 'agent.query', entity: 'agent', detail: { question: lastUser.slice(0, 200), tools: out.toolCalls.map((t) => t.name) } });
    });
    res.json(out);
  }));
  app.get('/api/dossiers/:id/agent/history', h(async (req, res) => {
    const userId = requireUser(req);
    res.json(await withUser(userId, (c) => agent.loadHistory(c, req.params.id, userId, 50)));
  }));
  // Decision Ledger — journal de preuves des décisions de Lexa (explicabilité / audit).
  app.get('/api/dossiers/:id/decisions', h(async (req, res) => {
    const userId = requireUser(req);
    const limit = Number(req.query.limit) || 30;
    res.json(await withUser(userId, (c) => ledgerDom.listDecisions(c, req.params.id, limit)));
  }));
  app.get('/api/dossiers/:id/decisions/:did', h(async (req, res) => {
    const userId = requireUser(req);
    const d = await withUser(userId, (c) => ledgerDom.getDecision(c, req.params.id, req.params.did));
    if (!d) { const e: any = new Error('Décision introuvable'); e.status = 404; throw e; }
    res.json(d);
  }));

  app.get('/api/dossiers/:id/fec', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    const content = await withUser(userId, (c) => fecExport(c, req.params.id, fy));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="FEC_${req.params.id.slice(0, 8)}.txt"`);
    res.send(content);
  }));
  app.get('/api/dossiers/:id/financial-statements-comparative', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => acc.financialStatementsComparative(c, req.params.id, fy)));
  }));
  app.get('/api/dossiers/:id/etats-comparatifs', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    const out = await withUser(userId, (c) => accdocs.etatsComparatifsPdf(c, req.params.id, fy));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
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
