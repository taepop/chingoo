import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="(auth)/login" options={{ headerShown: false }} />
      <Stack.Screen name="(onboarding)/index" options={{ headerShown: false }} />
      <Stack.Screen name="(chat)/index" options={{ headerShown: false }} />
    </Stack>
  );
}
