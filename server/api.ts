import express, { type Request, type Response, type NextFunction } from 'express';
import { withUser, pool } from './db.js';
import * as acc from './domain/accounting.js';
import * as users from './domain/users.js';
import { hashPassword, verifyPassword, issueToken, verifyToken } from './auth.js';
import { extractDocument, aiProvider } from './ai/provider.js';
import * as mm from './domain/mobilemoney.js';

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
    const { email, password } = req.body ?? {};
    const row = await withUser(null, (c) => users.getUserForLogin(c, String(email ?? '')));
    if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
      const e: any = new Error('Identifiants invalides'); e.status = 401; throw e;
    }
    const token = issueToken({ id: row.id, email: row.email, name: row.name ?? undefined });
    res.json({ token, user: { id: row.id, email: row.email, name: row.name } });
  }));

  app.get('/api/auth/me', h(async (req, res) => {
    const userId = requireUser(req);
    const user = await withUser(userId, (c) => users.getUser(c, userId));
    if (!user) { const e: any = new Error('Utilisateur introuvable'); e.status = 404; throw e; }
    res.json(user);
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

  app.get('/api/dossiers/:id/financial-statements', h(async (req, res) => {
    const userId = requireUser(req);
    const fy = (req.query.fiscalYearId as string) || undefined;
    res.json(await withUser(userId, (c) => acc.financialStatements(c, req.params.id, fy)));
  }));

  // 404 pour toute route API inconnue
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ressource introuvable' }));

  // Filet de sécurité : aucune erreur non gérée ne doit crasher le process
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Erreur non gérée:', err?.message ?? err);
    if (res.headersSent) return;
    res.status(err?.status ?? 500).json({ error: err?.message ?? 'Erreur serveur' });
  });

  return app;
}
