import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Disclaimer } from '../../src/components/Disclaimer';
import { MODEL_OPTIONS, US_STATES } from '../../src/constants/models';
import { colors, radius, spacing } from '../../src/constants/theme';
import { getProfile, saveProfile } from '../../src/lib/settings';
import { wipeAllData } from '../../src/db';
import {
  deleteApiKey,
  hasApiKey,
  looksLikeAnthropicKey,
  setApiKey,
} from '../../src/lib/secureStore';
import type { ModelId, ProfileSettings } from '../../src/types/models';

const EMPTY: ProfileSettings = {
  fullName: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  zip: '',
  model: 'claude-sonnet-4-6',
};

export default function SettingsScreen() {
  const [profile, setProfile] = useState<ProfileSettings>(EMPTY);
  const [keySet, setKeySet] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [statePickerOpen, setStatePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    let active = true;
    (async () => {
      const [p, k] = await Promise.all([getProfile(), hasApiKey()]);
      if (!active) return;
      setProfile(p);
      setKeySet(k);
    })();
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(reload);

  const update = (patch: Partial<ProfileSettings>) =>
    setProfile((prev) => ({ ...prev, ...patch }));

  async function onSaveProfile() {
    setSaving(true);
    try {
      await saveProfile(profile);
      Alert.alert('Saved', 'Your profile and model preference were saved.');
    } catch (e: any) {
      Alert.alert('Error', String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function onSaveKey() {
    const key = keyInput.trim();
    if (!looksLikeAnthropicKey(key)) {
      Alert.alert(
        'Check your key',
        'That does not look like an Anthropic API key (it should start with "sk-ant-"). Save it anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', onPress: () => persistKey(key) },
        ]
      );
      return;
    }
    persistKey(key);
  }

  async function persistKey(key: string) {
    try {
      await setApiKey(key);
      setKeyInput('');
      setKeySet(true);
      Alert.alert('Saved', 'Your API key is stored securely on this device only.');
    } catch (e: any) {
      Alert.alert('Error', String(e?.message ?? e));
    }
  }

  function onDeleteKey() {
    Alert.alert('Remove API key', 'Remove your stored Anthropic API key?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await deleteApiKey();
          setKeySet(false);
        },
      },
    ]);
  }

  function onWipe() {
    Alert.alert(
      'Wipe all data',
      'This permanently deletes all documents, items, letters, deadlines, and settings on this device. Your API key is not affected. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe everything',
          style: 'destructive',
          onPress: async () => {
            await wipeAllData();
            setProfile(EMPTY);
            Alert.alert('Done', 'All on-device data was wiped.');
          },
        },
      ]
    );
  }

  const stateName =
    US_STATES.find((s) => s.code === profile.state)?.name ?? 'Select your state';

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Disclaimer compact />

        {/* ---- Your details ---- */}
        <Section title="Your details">
          <Text style={styles.help}>
            Used to auto-fill the letters you generate. Stored only on this
            device.
          </Text>
          <Field
            label="Full name"
            value={profile.fullName}
            onChangeText={(t) => update({ fullName: t })}
            placeholder="Jane Q. Public"
          />
          <Field
            label="Address line 1"
            value={profile.addressLine1}
            onChangeText={(t) => update({ addressLine1: t })}
            placeholder="123 Main St"
          />
          <Field
            label="Address line 2"
            value={profile.addressLine2}
            onChangeText={(t) => update({ addressLine2: t })}
            placeholder="Apt 4B (optional)"
          />
          <Field
            label="City"
            value={profile.city}
            onChangeText={(t) => update({ city: t })}
            placeholder="Springfield"
          />

          <Text style={styles.label}>State</Text>
          <TouchableOpacity
            style={styles.select}
            onPress={() => setStatePickerOpen(true)}
          >
            <Text
              style={[
                styles.selectText,
                !profile.state && styles.selectPlaceholder,
              ]}
            >
              {stateName}
            </Text>
            <Text style={styles.selectChevron}>▾</Text>
          </TouchableOpacity>
          <Text style={styles.help}>
            Your state sets the statute-of-limitations rules (informational, not
            legal advice).
          </Text>

          <Field
            label="ZIP"
            value={profile.zip}
            onChangeText={(t) => update({ zip: t })}
            placeholder="00000"
            keyboardType="number-pad"
          />
        </Section>

        {/* ---- AI model ---- */}
        <Section title="AI model">
          {MODEL_OPTIONS.map((opt) => (
            <ModelRow
              key={opt.id}
              selected={profile.model === opt.id}
              label={opt.label}
              description={opt.description}
              onPress={() => update({ model: opt.id as ModelId })}
            />
          ))}
        </Section>

        <TouchableOpacity
          style={[styles.primaryBtn, saving && styles.btnDisabled]}
          onPress={onSaveProfile}
          disabled={saving}
        >
          <Text style={styles.primaryBtnText}>
            {saving ? 'Saving…' : 'Save profile & model'}
          </Text>
        </TouchableOpacity>

        {/* ---- API key ---- */}
        <Section title="Anthropic API key">
          <Text style={styles.help}>
            Required for AI extraction. Stored in the Android Keystore on this
            device only, and sent only to api.anthropic.com.
          </Text>
          <View style={styles.keyStatusRow}>
            <View
              style={[
                styles.dot,
                { backgroundColor: keySet ? colors.accent : colors.danger },
              ]}
            />
            <Text style={styles.keyStatusText}>
              {keySet ? 'A key is currently saved' : 'No key saved yet'}
            </Text>
          </View>
          <TextInput
            style={styles.input}
            value={keyInput}
            onChangeText={setKeyInput}
            placeholder={keySet ? 'Enter a new key to replace' : 'sk-ant-...'}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.primaryBtn, styles.flex, !keyInput && styles.btnDisabled]}
              onPress={onSaveKey}
              disabled={!keyInput}
            >
              <Text style={styles.primaryBtnText}>
                {keySet ? 'Replace key' : 'Save key'}
              </Text>
            </TouchableOpacity>
            {keySet && (
              <TouchableOpacity
                style={[styles.dangerBtn, styles.flex]}
                onPress={onDeleteKey}
              >
                <Text style={styles.dangerBtnText}>Remove</Text>
              </TouchableOpacity>
            )}
          </View>
        </Section>

        {/* ---- Danger zone ---- */}
        <Section title="Data">
          <Text style={styles.help}>
            Everything is stored only on this device. There is no backend, no
            server, and no analytics.
          </Text>
          <TouchableOpacity style={styles.dangerBtnFull} onPress={onWipe}>
            <Text style={styles.dangerBtnText}>Wipe all data</Text>
          </TouchableOpacity>
        </Section>

        <Text style={styles.version}>AI Credit Repair · v1.0.0</Text>
      </ScrollView>

      {/* ---- State picker modal ---- */}
      <Modal
        visible={statePickerOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setStatePickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setStatePickerOpen(false)}
        >
          <Pressable style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Select your state</Text>
            <FlatList
              data={US_STATES}
              keyExtractor={(s) => s.code}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.stateRow}
                  onPress={() => {
                    update({ state: item.code });
                    setStatePickerOpen(false);
                  }}
                >
                  <Text style={styles.stateName}>{item.name}</Text>
                  <Text style={styles.stateCode}>{item.code}</Text>
                </TouchableOpacity>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Field({
  label,
  ...props
}: { label: string } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textMuted}
        autoCorrect={false}
        {...props}
      />
    </View>
  );
}

function ModelRow({
  selected,
  label,
  description,
  onPress,
}: {
  selected: boolean;
  label: string;
  description: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.modelRow, selected && styles.modelRowSelected]}
      onPress={onPress}
    >
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected && <View style={styles.radioDot} />}
      </View>
      <View style={styles.flex}>
        <Text style={styles.modelLabel}>{label}</Text>
        <Text style={styles.modelDesc}>{description}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, paddingBottom: spacing.xl * 2 },
  section: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  help: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 17,
    marginBottom: spacing.sm,
  },
  fieldWrap: { marginBottom: spacing.sm },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.inputBg,
  },
  select: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.inputBg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectText: { fontSize: 15, color: colors.text },
  selectPlaceholder: { color: colors.textMuted },
  selectChevron: { color: colors.textMuted, fontSize: 14 },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  modelRowSelected: {
    borderColor: colors.accent,
    backgroundColor: '#EAF6F1',
  },
  modelLabel: { fontWeight: '700', color: colors.text },
  modelDesc: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.accent },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  btnDisabled: { opacity: 0.5 },
  row: { flexDirection: 'row', gap: spacing.sm },
  flex: { flex: 1 },
  keyStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  keyStatusText: { color: colors.text, fontSize: 13 },
  dangerBtn: {
    backgroundColor: '#FBECEC',
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  dangerBtnFull: {
    backgroundColor: '#FBECEC',
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  dangerBtnText: { color: colors.danger, fontWeight: '700' },
  version: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 11,
    marginTop: spacing.sm,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.md,
    maxHeight: '70%',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  stateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  stateName: { fontSize: 15, color: colors.text },
  stateCode: { fontSize: 15, color: colors.textMuted, fontWeight: '600' },
});
