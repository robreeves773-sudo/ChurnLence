import {
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonToast,
} from '@ionic/react';
import { useState } from 'react';
import type { CoinAlertMode } from '../core/types';
import { COINS } from '../data/coins';
import type { OverkillApi } from './useOverkill';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function SettingsPage({ api }: { api: OverkillApi }) {
  const { settings, updateSettings, sendTestAlert } = api;
  const [toast, setToast] = useState<string | null>(null);
  if (!settings) return null;

  const setCoinMode = (coinId: string, mode: CoinAlertMode) =>
    updateSettings({ ...settings, coinModes: { ...settings.coinModes, [coinId]: mode } });

  const setQuiet = (field: 'startHour' | 'endHour', value: number) =>
    updateSettings({ ...settings, quietHours: { ...settings.quietHours, [field]: value } });

  return (
    <>
      <IonList style={{ background: 'transparent' }}>
        <IonListHeader>
          <IonLabel className="ok-primary">ntfy alerts</IonLabel>
        </IonListHeader>
        <IonItem lines="none" className="ok-card" style={{ marginBottom: 8 }}>
          <IonLabel className="ion-text-wrap">
            <div className="ok-muted" style={{ fontSize: '0.75rem' }}>
              Topic (subscribe in the ntfy app)
            </div>
            <div className="ok-num" style={{ userSelect: 'all' }}>
              {settings.ntfyTopic}
            </div>
          </IonLabel>
        </IonItem>
        <IonButton
          expand="block"
          color="primary"
          onClick={async () => {
            await sendTestAlert();
            setToast('Test alert sent — check ntfy + your notification shade.');
          }}
        >
          Send test alert
        </IonButton>
      </IonList>

      <IonList style={{ background: 'transparent', marginTop: 16 }}>
        <IonListHeader>
          <IonLabel className="ok-primary">Quiet hours</IonLabel>
        </IonListHeader>
        <IonNote className="ion-padding-start" style={{ fontSize: '0.78rem' }}>
          Yellow/regime/stale alerts are silenced. Signal flips always break through.
        </IonNote>
        <IonItem className="ok-card" style={{ marginTop: 8 }}>
          <IonLabel>Start</IonLabel>
          <IonSelect
            value={settings.quietHours.startHour}
            onIonChange={(e) => setQuiet('startHour', e.detail.value)}
          >
            {HOURS.map((h) => (
              <IonSelectOption key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </IonSelectOption>
            ))}
          </IonSelect>
        </IonItem>
        <IonItem className="ok-card" style={{ marginTop: 8 }}>
          <IonLabel>End</IonLabel>
          <IonSelect
            value={settings.quietHours.endHour}
            onIonChange={(e) => setQuiet('endHour', e.detail.value)}
          >
            {HOURS.map((h) => (
              <IonSelectOption key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </IonSelectOption>
            ))}
          </IonSelect>
        </IonItem>
      </IonList>

      <IonList style={{ background: 'transparent', marginTop: 16 }}>
        <IonListHeader>
          <IonLabel className="ok-primary">Per-coin alerts</IonLabel>
        </IonListHeader>
        {COINS.map((coin) => {
          const mode = settings.coinModes[coin.id] ?? 'yellow';
          return (
            <div key={coin.id} className="ok-card" style={{ padding: 10, marginBottom: 8 }}>
              <div style={{ marginBottom: 6 }}>
                <strong>{coin.symbol}</strong>{' '}
                <span className="ok-muted" style={{ fontSize: '0.8rem' }}>
                  {coin.displayName}
                </span>
              </div>
              <IonSegment
                value={mode}
                onIonChange={(e) => setCoinMode(coin.id, e.detail.value as CoinAlertMode)}
              >
                <IonSegmentButton value="flip">
                  <IonLabel>Flip</IonLabel>
                </IonSegmentButton>
                <IonSegmentButton value="yellow">
                  <IonLabel>Flip + Yellow</IonLabel>
                </IonSegmentButton>
                <IonSegmentButton value="off">
                  <IonLabel>Off</IonLabel>
                </IonSegmentButton>
              </IonSegment>
            </div>
          );
        })}
      </IonList>

      <IonToast
        isOpen={toast !== null}
        message={toast ?? ''}
        duration={2500}
        onDidDismiss={() => setToast(null)}
      />
    </>
  );
}
