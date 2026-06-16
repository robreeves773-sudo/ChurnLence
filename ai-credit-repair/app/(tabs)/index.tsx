import { useCallback, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Disclaimer } from '../../src/components/Disclaimer';
import { hasApiKey } from '../../src/lib/secureStore';
import { getProfile } from '../../src/lib/settings';
import { colors, radius, spacing } from '../../src/constants/theme';

export default function Dashboard() {
  const [keySet, setKeySet] = useState<boolean | null>(null);
  const [profileReady, setProfileReady] = useState(false);

  // Re-check setup state every time this tab gains focus.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const key = await hasApiKey();
        const profile = await getProfile();
        if (!active) return;
        setKeySet(key);
        setProfileReady(!!profile.fullName && !!profile.state);
      })();
      return () => {
        active = false;
      };
    }, [])
  );

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Disclaimer />

        {keySet === false && (
          <SetupCard
            title="Add your Anthropic API key"
            body="The app reads your credit reports with AI. Add your key to get started — it is stored only on this device."
          />
        )}
        {keySet && !profileReady && (
          <SetupCard
            title="Complete your profile"
            body="Add your name, mailing address, and state so letters and the statute-of-limitations rules work correctly."
          />
        )}

        <Text style={styles.sectionTitle}>Overview</Text>
        <View style={styles.statsRow}>
          <Stat label="Items" value="0" />
          <Stat label="To review" value="0" />
          <Stat label="Active deadlines" value="0" />
        </View>

        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No credit reports yet</Text>
          <Text style={styles.emptyBody}>
            Upload screenshots from Credit Karma or official bureau PDFs from
            AnnualCreditReport.com to begin.
          </Text>
          <Link href="/upload" asChild>
            <TouchableOpacity style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Upload a report</Text>
            </TouchableOpacity>
          </Link>
        </View>

        <Text style={styles.note}>
          All data lives only on this device. The only outbound network call is
          to the Anthropic API.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SetupCard({ title, body }: { title: string; body: string }) {
  return (
    <Link href="/settings" asChild>
      <TouchableOpacity style={styles.setupCard}>
        <Text style={styles.setupTitle}>⚠️  {title}</Text>
        <Text style={styles.setupBody}>{body}</Text>
        <Text style={styles.setupLink}>Open Settings →</Text>
      </TouchableOpacity>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textMuted,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  stat: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    alignItems: 'center',
  },
  statValue: { fontSize: 24, fontWeight: '800', color: colors.primary },
  statLabel: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  emptyCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  emptyBody: {
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700' },
  setupCard: {
    backgroundColor: '#E9F5F0',
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  setupTitle: { fontWeight: '700', color: colors.primary, marginBottom: 4 },
  setupBody: { color: colors.text, fontSize: 13, lineHeight: 18 },
  setupLink: {
    color: colors.accent,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  note: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
