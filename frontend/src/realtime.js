import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { authApi } from './auth/api.js';

export function useRoomStatusUpdates(propertyId, onUpdate, onMaintenanceUpdate) {
  const updateRef = useRef(onUpdate);
  const maintenanceUpdateRef = useRef(onMaintenanceUpdate);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    updateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    maintenanceUpdateRef.current = onMaintenanceUpdate;
  }, [onMaintenanceUpdate]);

  useEffect(() => {
    if (!propertyId) return undefined;
    const socket = io('/', {
      auth: (callback) => callback(authApi.realtimeCredentials()),
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      withCredentials: true,
    });
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('room:status', (update) => updateRef.current(update));
    socket.on('maintenance:ticket', (update) => maintenanceUpdateRef.current?.(update));
    return () => {
      socket.disconnect();
      setConnected(false);
    };
  }, [propertyId]);

  return connected;
}
