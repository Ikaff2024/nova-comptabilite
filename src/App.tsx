import React, { useEffect, useState } from 'react';
import { LayoutDashboard, FolderKanban, LogOut, Hexagon, Loader2, RotateCcw, HelpCircle, BookOpen, Building2, Gauge, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
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
import { cn } from './lib/utils';

export default function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [cabinets, setCabinets] = useState<Cabinet[]>([]);
  const [loadingCabinets, setLoadingCabinets] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Dossier | null>(null);
  const [nav, setNav] = useState<'dashboard' | 'portefeuille' | 'cabinet' | 'platform'>('dashboard');
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

  // Guide d'accueil : au premier passage avec un cabinet créé.
  useEffect(() => {
    if (user && cabinets.length > 0 && !isWelcomed()) setShowGuide(true);
  }, [user, cabinets]);

  const onAuth = async (u: AuthUser) => { setUser(u); await loadCabinets(); };
  const onDemoCreated = (id: string) => { setShowGuide(false); setDashKey((k) => k + 1); openDossierById(id); };
  const logout = () => { clearToken(); setUser(null); setCabinets([]); setSelected(null); };

  if (booting) {
    return <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
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
          <div className="text-xs text-zinc-500">Cabinet</div>
          <div className="truncate text-sm font-medium text-zinc-200">{cabinet.name}</div>
        </div>

        <nav className="mt-6 flex flex-1 flex-col gap-2">
          {([
            { id: 'dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
            { id: 'portefeuille', label: 'Portefeuille', icon: FolderKanban },
            { id: 'cabinet', label: 'Cabinet & sécurité', icon: Building2 },
            ...(user.platformAdmin ? [{ id: 'platform', label: 'Console Nova', icon: Gauge } as const] : []),
          ] as const).map((item) => {
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
            : nav === 'dashboard'
              ? <CabinetDashboard refresh={dashKey} cabinetName={cabinet.name} onOpen={openDossierById} onDemo={onDemoCreated} />
              : nav === 'cabinet'
                ? <CabinetSettings cabinet={cabinet} user={user} onUserRefresh={refreshMe} onRenamed={loadCabinets} />
                : nav === 'platform' && user.platformAdmin
                  ? <PlatformConsole />
                  : <Dossiers cabinet={cabinet} onOpen={setSelected} />}
        </div>
      </main>

      {showGuide && <WelcomeGuide onClose={() => setShowGuide(false)} onDemo={onDemoCreated} />}
    </div>
  );
}
