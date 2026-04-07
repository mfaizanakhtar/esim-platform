import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { AppShell } from '@/components/layout/AppShell';
import { Login } from '@/pages/Login';

const Deliveries = lazy(() => import('@/pages/Deliveries').then((m) => ({ default: m.Deliveries })));
const DeliveryDetail = lazy(() => import('@/pages/DeliveryDetail').then((m) => ({ default: m.DeliveryDetail })));
const SkuMappings = lazy(() => import('@/pages/SkuMappings').then((m) => ({ default: m.SkuMappings })));
const AiMap = lazy(() => import('@/pages/AiMap').then((m) => ({ default: m.AiMap })));
const Catalog = lazy(() => import('@/pages/Catalog').then((m) => ({ default: m.Catalog })));

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/deliveries" replace />} />
          <Route
            path="/deliveries"
            element={
              <Suspense fallback={<PageLoader />}>
                <Deliveries />
              </Suspense>
            }
          />
          <Route
            path="/deliveries/:id"
            element={
              <Suspense fallback={<PageLoader />}>
                <DeliveryDetail />
              </Suspense>
            }
          />
          <Route
            path="/sku-mappings"
            element={
              <Suspense fallback={<PageLoader />}>
                <SkuMappings />
              </Suspense>
            }
          />
          <Route
            path="/sku-mappings/ai-map"
            element={
              <Suspense fallback={<PageLoader />}>
                <AiMap />
              </Suspense>
            }
          />
          <Route
            path="/catalog"
            element={
              <Suspense fallback={<PageLoader />}>
                <Catalog />
              </Suspense>
            }
          />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/deliveries" replace />} />
    </Routes>
  );
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="h-8 w-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
    </div>
  );
}
