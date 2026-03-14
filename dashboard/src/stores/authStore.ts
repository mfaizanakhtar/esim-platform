import { create } from 'zustand';

const SESSION_KEY = 'esim-admin-api-key';

interface AuthState {
  apiKey: string | null;
  login: (key: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  apiKey: sessionStorage.getItem(SESSION_KEY),

  login: (key: string) => {
    sessionStorage.setItem(SESSION_KEY, key);
    set({ apiKey: key });
  },

  logout: () => {
    sessionStorage.removeItem(SESSION_KEY);
    set({ apiKey: null });
  },
}));
