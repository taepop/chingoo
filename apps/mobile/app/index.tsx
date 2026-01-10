import { Redirect } from 'expo-router';

/**
 * Root Index Screen
 * Redirects to login for now
 */
export default function Index() {
  return <Redirect href="/(auth)/login" />;
}
