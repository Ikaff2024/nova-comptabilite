import React, { useEffect, useState } from 'react';
import { LayoutDashboard, FolderKanban, LogOut, Hexagon, Loader2, RotateCcw, HelpCircle, BookOpen, Building2, Gauge, PanelLeftClose, PanelLeftOpen, Sun, Moon } from 'lucide-react';
import { api, type Cabinet, type Dossier, type AuthUser } from './lib/api';
import { getToken, clearToken, isWelcomed } from './lib/session';
import Auth from './components/Auth';
import Onboarding from './components/Onboarding';
import Dossiers from './components/Dossiers';
import DossierView from './components/DossierView';
import ClientPortal from './components/ClientPortal';
import CabinetDashboard from './components/CabinetDashboard';
import CabinetSettings from './components/CabinetSettings';
import PlatformConsole from './components/PlatformConsole';
import WelcomeGuide from './components/WelcomeGuide';
import InviteAccept from './components/InviteAccept';
import { cn } from './lib/utils';

export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [cabinets, setCabinets] = useState<Cabinet[]>([]);
  const [loadingCabinets, setLoadingCabinets] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Dossier | null>(null);
  const [nav, setNav] = useState<'dashboard' | 'portefeuille' | 'cabinet' | 'platform'>('dashboard');
  // Mode entreprise : le compte n'a qu'un dossier (sa propre société), chargé
  // ici pour un atterrissage direct dans sa comptabilité (pas de portefeuille).
  const [companyDossier, setCompanyDossier] = useState<Dossier | null>(null);
  const [companyLoaded, setCompanyLoaded] = useState(false);
  // Lien d'invitation reçu par email : /?invite=<token>
  const [inviteToken, setInviteToken] = useState<string | null>(() => {
    try { return new URLSearchParams(window.location.search).get('invite'); } catch { return null; }
  });
  const clearInvite = () => {
    setInviteToken(null);
    try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ }
  };
  const refreshMe = async () => { try { setUser(await api.me()); } catch { /* ignore */ } };
  const [showGuide, setShowGuide] = useState(false);
  const [dashKey, setDashKey] = useState(0); // force refresh du dashboard après démo
  // Barre latérale masquable (pour un écran plus dégagé) — préférence mémorisée.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return localStorage.getItem('nova.sidebar') !== 'closed'; } catch { return true; }
  });
  const toggleSidebar = () => setSidebarOpen((o) => {
    const next = !o;
    try { localStorage.setItem('nova.sidebar', next ? 'open' : 'closed'); } catch { /* ignore */ }
    return next;
  });
  // Thème clair/sombre (« choix 2 » pour ceux qui préfèrent le clair). Appliqué
  // sur la racine dès le montage, même sur les écrans de connexion.
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('nova.theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('nova.theme', theme); } catch { /* ignore */ }
  }, [theme]);

  const openDossierById = async (id: string) => {
    try {
      const list = await api.dossiers();
      const d = list.find((x) => x.id === id);
      if (d) setSelected(d);
      else setError("Dossier introuvable ou accès refusé.");
    } catch (e: any) {
      setError(e?.message ? `Ouverture impossible : ${e.message}` : 'Ouverture du dossier impossible.');
    }
  };

  const loadCabinets = async () => {
    setLoadingCabinets(true); setError(null);
    try { setCabinets(await api.cabinets()); }
    catch (e: any) { setError(e.message); }
    finally { setLoadingCabinets(false); }
  };

  // Au démarrage : restaurer la session si un token est présent.
  useEffect(() => {
    (async () => {
      if (getToken()) {
        try { const me = await api.me(); setUser(me); await loadCabinets(); }
        catch { clearToken(); setUser(null); }
      }
      setBooting(false);
    })();
  }, []);

  // Guide d'accueil : au premier passage avec un cabinet créé. En mode
  // entreprise, on ne propose pas la démo (elle créerait un dossier parasite).
  useEffect(() => {
    if (user && cabinets.length > 0 && cabinets[0].account_type !== 'entreprise' && !isWelcomed()) setShowGuide(true);
  }, [user, cabinets]);

  // Mode entreprise : précharger le dossier unique de la société.
  useEffect(() => {
    const cab = cabinets[0];
    if (cab && cab.account_type === 'entreprise') {
      setCompanyLoaded(false);
      api.dossiers().then((ds) => setCompanyDossier(ds[0] ?? null)).catch(() => setCompanyDossier(null)).finally(() => setCompanyLoaded(true));
    } else {
      setCompanyDossier(null); setCompanyLoaded(false);
    }
  }, [cabinets]);

  const onAuth = async (u: AuthUser) => { setUser(u); await loadCabinets(); };
  const onDemoCreated = (id: string) => { setShowGuide(false); setDashKey((k) => k + 1); openDossierById(id); };
  const logout = () => { clearToken(); setUser(null); setCabinets([]); setSelected(null); };

  if (booting) {
    return <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  // Lien d'invitation : écran dédié, accessible même sans être connecté.
  if (inviteToken) {
    return (
      <InviteAccept
        token={inviteToken}
        loggedIn={!!user}
        onDone={async (u) => { clearInvite(); if (u) setUser(u); await loadCabinets(); }}
        onCancel={clearInvite}
      />
    );
  }

  if (!user) return <Auth onAuth={onAuth} />;

  if (loadingCabinets) {
    return <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-zinc-950 text-center text-zinc-300">
        <p className="max-w-md text-rose-400">Impossible de joindre l'API : {error}</p>
        <p className="text-sm text-zinc-500">Lancez le backend : <code className="rounded bg-white/10 px-1.5 py-0.5">npm run api</code></p>
        <button onClick={loadCabinets} className="flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20"><RotateCcw className="h-4 w-4" /> Réessayer</button>
      </div>
    );
  }

  if (cabinets.length === 0) return <Onboarding onDone={loadCabinets} />;

  const cabinet = cabinets[0];
  const isCompany = cabinet.account_type === 'entreprise';
  type NavItem = { id: 'dashboard' | 'portefeuille' | 'cabinet' | 'platform'; label: string; icon: typeof LayoutDashboard };
  const platformItem: NavItem[] = user.platformAdmin ? [{ id: 'platform', label: 'Console Nova', icon: Gauge }] : [];
  const navItems: NavItem[] = isCompany
    ? [
        { id: 'dashboard', label: 'Mon entreprise', icon: LayoutDashboard },
        { id: 'cabinet', label: 'Entreprise & sécurité', icon: Building2 },
        ...platformItem,
      ]
    : [
        { id: 'dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
        { id: 'portefeuille', label: 'Portefeuille', icon: FolderKanban },
        { id: 'cabinet', label: 'Cabinet & sécurité', icon: Building2 },
        ...platformItem,
      ];

  return (
    <div className="flex h-screen w-full bg-zinc-950 font-sans text-zinc-50 selection:bg-emerald-500/30">
      {sidebarOpen && (
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/5 bg-zinc-950/50 p-6 backdrop-blur-2xl">
        <div className="flex items-center gap-3 px-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-lg shadow-emerald-500/20">
            <Hexagon className="h-6 w-6 text-zinc-950" fill="currentColor" />
          </div>
          <span className="font-display text-xl font-bold tracking-tight text-white">Nova</span>
          <button onClick={toggleSidebar} title="Masquer la barre latérale"
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200">
            <PanelLeftClose className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-8 rounded-xl border border-white/5 bg-white/5 px-3 py-2.5">
          <div className="text-xs text-zinc-500">{isCompany ? 'Entreprise' : 'Cabinet'}</div>
          <div className="truncate text-sm font-medium text-zinc-200">{cabinet.name}</div>
        </div>

        <nav className="mt-6 flex flex-1 flex-col gap-2">
          {navItems.map((item) => {
            const active = !selected && nav === item.id;
            return (
              <button key={item.id} onClick={() => { setSelected(null); setNav(item.id); }}
                className={cn('group flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all',
                  active ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200')}>
                <item.icon className={cn('h-5 w-5', active ? 'text-emerald-400' : 'text-zinc-500 group-hover:text-zinc-400')} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto space-y-1 border-t border-white/5 pt-6">
          <div className="mb-2 flex rounded-xl border border-white/10 bg-white/5 p-0.5">
            {([['dark', 'Sombre', Moon], ['light', 'Clair', Sun]] as const).map(([k, label, Icon]) => (
              <button key={k} onClick={() => setTheme(k)}
                className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors',
                  theme === k ? 'bg-emerald-500 text-zinc-950' : 'text-zinc-400 hover:text-zinc-200')}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
          <div className="truncate px-2 pb-2 text-xs text-zinc-500">{user.name || user.email}</div>
          <button onClick={() => setShowGuide(true)} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-zinc-400 transition-all hover:bg-white/5 hover:text-emerald-400">
            <HelpCircle className="h-5 w-5" />
            Guide de prise en main
          </button>
          <a href="/guide.html" target="_blank" rel="noopener" className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-zinc-400 transition-all hover:bg-white/5 hover:text-emerald-400">
            <BookOpen className="h-5 w-5" />
            Guide complet (modules)
          </a>
          <button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-zinc-400 transition-all hover:bg-white/5 hover:text-rose-400">
            <LogOut className="h-5 w-5" />
            Déconnexion
          </button>
        </div>
      </aside>
      )}

      <main className="relative flex-1 overflow-y-auto overflow-x-hidden p-6 lg:p-8">
        {!sidebarOpen && (
          <button onClick={toggleSidebar} title="Afficher la barre latérale"
            className="sticky top-0 z-10 -mt-2 mb-2 flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-zinc-900/80 text-zinc-300 backdrop-blur-xl transition-colors hover:bg-white/10 hover:text-white">
            <PanelLeftOpen className="h-5 w-5" />
          </button>
        )}
        <div className="mx-auto max-w-[1760px]">
          {selected
            ? (selected.role === 'client' || selected.role === 'lecture')
              ? <ClientPortal dossier={selected} onBack={() => setSelected(null)} />
              : <DossierView dossier={selected} onBack={() => setSelected(null)} />
            : isCompany
              ? nav === 'cabinet'
                ? <CabinetSettings cabinet={cabinet} user={user} onUserRefresh={refreshMe} onRenamed={loadCabinets} isCompany />
                : nav === 'platform' && user.platformAdmin
                  ? <PlatformConsole />
                  : companyDossier
                    ? <DossierView dossier={companyDossier} onBack={() => {}} hideBack />
                    : companyLoaded
                      ? <CompanySetup cabinet={cabinet} onCreated={loadCabinets} />
                      : <div className="flex h-full items-center justify-center text-zinc-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
              : nav === 'dashboard'
                ? <CabinetDashboard refresh={dashKey} cabinetName={cabinet.name} onOpen={openDossierById} onDemo={onDemoCreated} />
                : nav === 'cabinet'
                  ? <CabinetSettings cabinet={cabinet} user={user} onUserRefresh={refreshMe} onRenamed={loadCabinets} isCompany={false} />
                  : nav === 'platform' && user.platformAdmin
                    ? <PlatformConsole />
                    : <Dossiers cabinet={cabinet} onOpen={setSelected} />}
        </div>
      </main>

      {showGuide && <WelcomeGuide onClose={() => setShowGuide(false)} onDemo={onDemoCreated} />}
    </div>
  );
}

// Mode entreprise sans dossier (ex. compte converti depuis « cabinet ») :
// invite à créer la comptabilité de la société, préremplie avec son nom.
function CompanySetup({ cabinet, onCreated }: { cabinet: Cabinet; onCreated: () => void }) {
  const [name, setName] = useState(cabinet.name);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!name.trim()) return;
    setLoading(true); setError(null);
    try { await api.createDossier({ cabinetId: cabinet.id, raisonSociale: name.trim(), country: cabinet.country }); onCreated(); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-white/10 bg-white/5 p-8">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400"><Building2 className="h-6 w-6" /></div>
      <h1 className="mt-4 font-display text-2xl font-bold tracking-tight">Configurons votre société</h1>
      <p className="mt-1 text-zinc-400">Nous créons la comptabilité de votre entreprise (plan SYSCOHADA inclus). Vous pourrez tout gérer ici : saisie, paie, états financiers, Lexa.</p>
      <label className="mt-6 mb-1.5 block text-sm font-medium text-zinc-300">Nom de l'entreprise</label>
      <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
        className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2.5 text-sm outline-none focus:border-emerald-500/50" />
      {error && <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-400">{error}</p>}
      <button onClick={create} disabled={loading || !name.trim()}
        className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
        {loading && <Loader2 className="h-4 w-4 animate-spin" />} Créer ma comptabilité
      </button>
    </div>
  );
}
