/**
 * Token Storage
 * Persists access token for API authentication
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const TOKEN_KEY = '@chingoo:access_token';

export const tokenStorage = {
  async saveToken(token: string): Promise<void> {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  },

  async getToken(): Promise<string | null> {
    return await AsyncStorage.getItem(TOKEN_KEY);
  },

  async removeToken(): Promise<void> {
    await AsyncStorage.removeItem(TOKEN_KEY);
  },
};
