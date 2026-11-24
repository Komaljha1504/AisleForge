export type Role = 'customer' | 'picker' | 'supervisor' | 'admin';

export interface Profile {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  storeId: number | null;
}

export interface RouteStop {
  sequence: number;
  orderLineId: string;
  sku: string;
  aisle: number;
  pos: number;
  zone: string;
  arrivalDistanceMeters: number;
  arrivalSeconds: number;
}

export interface TaskRoute {
  algorithm: string | null;
  distanceMeters: number | null;
  estimatedSeconds: number | null;
  fallbackUsed: boolean;
  stops: RouteStop[];
  unrouted: { orderLineId: string; sku: string; reason: string }[];
  reason: string | null;
}

export interface TaskLine {
  orderLineId: string;
  lineNo: number;
  sku: string;
  productName: string;
  zone: string;
  qty: number;
  pickedQty: number;
  shortQty: number;
  reservationId: string | null;
  reservationStatus: string | null;
  location: { aisle: number; pos: number } | null;
}

export interface TaskView {
  id: string;
  orderId: string;
  storeId: number;
  status: 'open' | 'claimed' | 'completed' | 'cancelled';
  version: number;
  assignedTo: string | null;
  assignedToName: string | null;
  leaseExpiresAt: string | null;
  routeStatus: 'feasible' | 'fallback' | 'infeasible' | 'unplanned';
  route: TaskRoute;
  orderStatus: string;
  createdAt: string;
  completedAt: string | null;
  lines?: TaskLine[];
}

export interface Store {
  id: number;
  code: string;
  name: string;
  hasLayout: boolean;
}

export interface CatalogItem {
  sku: string;
  name: string;
  zone: string;
  unitPriceCents: number;
  available: number;
}

export interface OrderSummary {
  id: string;
  storeId: number;
  customerId: string;
  status: string;
  version: number;
  createdAt: string;
}

export interface OrderDetail extends OrderSummary {
  lines: {
    lineNo: number;
    sku: string;
    qty: number;
    pickedQty: number;
    shortQty: number;
    reservationStatus: string | null;
  }[];
}

export type OpType = 'pick.confirm' | 'task.complete';
export type OpStatus = 'pending' | 'applied' | 'rejected';

export interface QueuedOp {
  opId: string;
  seq: number;
  userId: string;
  deviceId: string;
  type: OpType;
  taskId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: OpStatus;
  reason?: string;
  message?: string;
  settledAt?: string;
}

/** Local (device) state of a line while its pick may not be synchronized yet. */
export interface LocalLineState {
  pickedQty: number;
  scannedSku: string;
  opId: string;
  status: OpStatus;
  reason?: string;
}

export interface CachedTask {
  taskId: string;
  userId: string;
  task: TaskView;
  local: Record<string, LocalLineState>;
  complete?: { opId: string; status: OpStatus; reason?: string };
  cachedAt: string;
}
