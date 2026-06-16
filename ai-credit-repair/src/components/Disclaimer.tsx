import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../constants/theme';

// Reusable "not legal advice" banner shown throughout the app.
export function Disclaimer({ compact = false }: { compact?: boolean }) {
  return (
    <View style={styles.box}>
      <Text style={styles.text}>
        {compact
          ? 'Not legal advice. Verify every item against your official reports and review each letter before mailing.'
          : 'This app provides general information, not legal advice. AI extraction can make mistakes — verify every item against your official credit reports, and review each item and letter before you act. You mail all letters yourself.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: '#FFF6E6',
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  text: {
    color: '#6B4E12',
    fontSize: 12,
    lineHeight: 17,
  },
});
