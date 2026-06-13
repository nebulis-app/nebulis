import { fetchJSON } from './client';

export interface WishlistItem {
  id: string;
  objectId: string;
  name: string;
  type: string;
  constellation: string | null;
  magnitude: number | null;
  majorAxisArcmin: number | null;
  priority: 'high' | 'medium' | 'low';
  notes: string;
  addedAt: string;
}

export const getWishlist = () => fetchJSON<WishlistItem[]>('/wishlist');
export const addToWishlist = (item: Omit<WishlistItem, 'id' | 'addedAt'>) =>
  fetchJSON<WishlistItem>('/wishlist', { method: 'POST', body: JSON.stringify(item) });
export const updateWishlistItem = (id: string, data: { priority?: WishlistItem['priority']; notes?: string }) =>
  fetchJSON<WishlistItem>(`/wishlist/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const removeFromWishlist = (id: string) =>
  fetchJSON<{ deleted: boolean }>(`/wishlist/${id}`, { method: 'DELETE' });
