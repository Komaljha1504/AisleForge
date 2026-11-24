import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import type { Role } from './lib/types';
import { DeadLettersPage, DiagnosticsPage, UsersPage } from './pages/admin/Admin';
import { OrdersPage } from './pages/customer/Orders';
import { ShopPage } from './pages/customer/Shop';
import { LoginPage, homeFor } from './pages/Login';
import { PickPage } from './pages/picker/Pick';
import { SyncCenterPage } from './pages/picker/SyncCenter';
import { TasksPage } from './pages/picker/Tasks';
import { InventoryPage, RejectionsPage, SupervisorOverviewPage } from './pages/supervisor/Supervisor';

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <>{children}</>;
}

function Routed() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label="Starting" />
      </div>
    );
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={user ? <Layout /> : <Navigate to="/login" replace />}>
        <Route
          path="/shop"
          element={
            <Guard roles={['customer']}>
              <ShopPage />
            </Guard>
          }
        />
        <Route
          path="/orders"
          element={
            <Guard roles={['customer']}>
              <OrdersPage />
            </Guard>
          }
        />
        <Route
          path="/tasks"
          element={
            <Guard roles={['picker', 'supervisor']}>
              <TasksPage />
            </Guard>
          }
        />
        <Route
          path="/tasks/:id"
          element={
            <Guard roles={['picker', 'supervisor']}>
              <PickPage />
            </Guard>
          }
        />
        <Route
          path="/sync"
          element={
            <Guard roles={['picker', 'supervisor']}>
              <SyncCenterPage />
            </Guard>
          }
        />
        <Route
          path="/supervisor"
          element={
            <Guard roles={['supervisor']}>
              <SupervisorOverviewPage />
            </Guard>
          }
        />
        <Route
          path="/supervisor/rejections"
          element={
            <Guard roles={['supervisor', 'admin']}>
              <RejectionsPage />
            </Guard>
          }
        />
        <Route
          path="/supervisor/inventory"
          element={
            <Guard roles={['supervisor', 'admin']}>
              <InventoryPage />
            </Guard>
          }
        />
        <Route
          path="/admin/diagnostics"
          element={
            <Guard roles={['admin']}>
              <DiagnosticsPage />
            </Guard>
          }
        />
        <Route
          path="/admin/dead-letters"
          element={
            <Guard roles={['admin']}>
              <DeadLettersPage />
            </Guard>
          }
        />
        <Route
          path="/admin/users"
          element={
            <Guard roles={['admin']}>
              <UsersPage />
            </Guard>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to={user ? homeFor(user.role) : '/login'} replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routed />
      </BrowserRouter>
    </AuthProvider>
  );
}
