import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { AppShell } from '@/components/layout/AppShell';
import { Login } from '@/pages/Login';
import { Deliveries } from '@/pages/Deliveries';
import { DeliveryDetail } from '@/pages/DeliveryDetail';
import { SkuMappings } from '@/pages/SkuMappings';
import { Catalog } from '@/pages/Catalog';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/deliveries" replace />} />
          <Route path="/deliveries" element={<Deliveries />} />
          <Route path="/deliveries/:id" element={<DeliveryDetail />} />
          <Route path="/sku-mappings" element={<SkuMappings />} />
          <Route path="/catalog" element={<Catalog />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/deliveries" replace />} />
    </Routes>
  );
}
