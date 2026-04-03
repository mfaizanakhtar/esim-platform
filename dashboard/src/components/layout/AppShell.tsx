import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { LayoutDashboard, Map as MapIcon, Package, LogOut, Menu, X } from 'lucide-react';

const navItems = [
  { to: '/deliveries', label: 'Deliveries', icon: LayoutDashboard },
  { to: '/sku-mappings', label: 'SKU Mappings', icon: MapIcon },
  { to: '/catalog', label: 'Catalog', icon: Package },
];

export function AppShell() {
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — fixed+off-screen on mobile, static in-flow on desktop */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-56 border-r flex flex-col bg-white transition-transform duration-200 md:static md:translate-x-0 md:visible ${
          sidebarOpen ? 'translate-x-0 visible' : '-translate-x-full invisible'
        }`}
      >
        <div className="p-4 border-b flex items-center justify-between">
          <Link to="/deliveries" className="text-lg font-semibold">
            eSIM Admin
          </Link>
          <button
            className="md:hidden p-1 rounded hover:bg-muted transition-colors"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-2 border-t">
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground w-full transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Logout
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
