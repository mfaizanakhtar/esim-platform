import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';

export function ProtectedRoute() {
  const apiKey = useAuthStore((s) => s.apiKey);
  if (!apiKey) return <Navigate to="/login" replace />;
  return <Outlet />;
}
