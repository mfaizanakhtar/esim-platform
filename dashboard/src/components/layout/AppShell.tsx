import { useState, useEffect, useRef } from 'react';
import { Link, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import {
  LayoutDashboard,
  Map as MapIcon,
  Package,
  ShoppingBag,
  LogOut,
  Menu,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';

const navItems = [
  { to: '/deliveries', label: 'Deliveries', icon: LayoutDashboard },
  { to: '/sku-mappings', label: 'SKU Mappings', icon: MapIcon },
  { to: '/catalog', label: 'Catalog', icon: Package },
  { to: '/product-templates', label: 'Products', icon: ShoppingBag },
];

function TopProgressBar() {
  const location = useLocation();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLocation = useRef(`${location.pathname}${location.search}${location.hash}`);

  useEffect(() => {
    const currentLocation = `${location.pathname}${location.search}${location.hash}`;
    if (prevLocation.current === currentLocation) return;
    prevLocation.current = currentLocation;

    setWidth(0);
    setVisible(true);
    const t1 = setTimeout(() => setWidth(80), 10);
    const t2 = setTimeout(() => {
      setWidth(100);
      timerRef.current = setTimeout(() => setVisible(false), 300);
    }, 200);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [location.pathname, location.search, location.hash]);

  if (!visible) return null;

  return (
    <div
      className="fixed top-0 left-0 z-[100] h-0.5 bg-primary transition-all ease-out"
      style={{ width: `${width}%`, transitionDuration: width === 100 ? '150ms' : '200ms' }}
    />
  );
}

export function AppShell() {
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebar-collapsed') !== 'false',
  );

  function handleLogout() {
    logout();
    navigate('/login');
  }

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('sidebar-collapsed', String(next));
      return next;
    });
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <TopProgressBar />

      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-56 border-r flex flex-col bg-white transition-all duration-200 md:static md:translate-x-0 md:visible ${
          sidebarOpen ? 'translate-x-0 visible' : '-translate-x-full invisible'
        } ${collapsed ? 'md:w-14' : 'md:w-56'}`}
      >
        <div className="p-3 border-b flex items-center justify-between min-h-[53px]">
          {!collapsed && (
            <Link to="/deliveries" className="text-lg font-semibold truncate">
              eSIM Admin
            </Link>
          )}
          <button
            className="md:hidden p-1 rounded hover:bg-muted transition-colors ml-auto"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, label, icon: Icon }) => {
            const isActive = location.pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                title={collapsed ? label : undefined}
                onClick={() => setSidebarOpen(false)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                  collapsed ? 'justify-center' : ''
                } ${
                  isActive
                    ? 'bg-gray-900 text-white'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && label}
              </Link>
            );
          })}
        </nav>
        <div className="p-2 border-t space-y-1">
          {/* Collapse toggle — desktop only */}
          <button
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={`hidden md:flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground w-full transition-colors ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4 shrink-0" />
            ) : (
              <>
                <PanelLeftClose className="h-4 w-4 shrink-0" />
                Collapse
              </>
            )}
          </button>
          <button
            onClick={handleLogout}
            title={collapsed ? 'Logout' : undefined}
            className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground w-full transition-colors ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && 'Logout'}
          </button>
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden flex items-center gap-3 px-4 h-12 border-b shrink-0 bg-white">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1 rounded hover:bg-muted transition-colors"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-base font-semibold">eSIM Admin</span>
        </header>

        <main className="flex-1 overflow-auto p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
