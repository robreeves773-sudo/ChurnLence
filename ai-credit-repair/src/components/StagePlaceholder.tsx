import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Disclaimer } from './Disclaimer';
import { colors, radius, spacing } from '../constants/theme';

// Used by tabs whose full functionality arrives in a later build stage.
export function StagePlaceholder({
  emoji,
  title,
  description,
  stage,
}: {
  emoji: string;
  title: string;
  description: string;
  stage: string;
}) {
  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Disclaimer compact />
        <View style={styles.card}>
          <Text style={styles.emoji}>{emoji}</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.desc}>{description}</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Coming in {stage}</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, flexGrow: 1 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    alignItems: 'center',
  },
  emoji: { fontSize: 40, marginBottom: spacing.sm },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  desc: {
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  badge: {
    marginTop: spacing.lg,
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badgeText: { color: colors.primaryLight, fontWeight: '700', fontSize: 12 },
});
