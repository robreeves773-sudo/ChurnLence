import { useState } from 'react';
import {
  IonApp,
  IonContent,
  IonFooter,
  IonHeader,
  IonPage,
  IonSegment,
  IonSegmentButton,
  IonLabel,
  IonTitle,
  IonToolbar,
  IonSpinner,
} from '@ionic/react';
import Dashboard from './Dashboard';
import SettingsPage from './Settings';
import { useOverkill } from './useOverkill';

type Tab = 'signals' | 'settings';

export default function App() {
  const api = useOverkill();
  const [tab, setTab] = useState<Tab>('signals');

  return (
    <IonApp>
      <IonPage>
        <IonHeader>
          <IonToolbar>
            <IonTitle>
              <span className="ok-primary" style={{ fontWeight: 800, letterSpacing: '0.04em' }}>
                OVERKILL
              </span>{' '}
              <span className="ok-muted" style={{ fontSize: '0.8rem' }}>
                signals
              </span>
            </IonTitle>
          </IonToolbar>
        </IonHeader>

        <IonContent className="ion-padding">
          {!api.ready ? (
            <div style={{ textAlign: 'center', marginTop: '40%' }}>
              <IonSpinner name="dots" color="primary" />
              <p className="ok-muted">Warming up the 200 EMA…</p>
            </div>
          ) : tab === 'signals' ? (
            <Dashboard api={api} />
          ) : (
            <SettingsPage api={api} />
          )}
        </IonContent>

        <IonFooter>
          <IonToolbar>
            <IonSegment value={tab} onIonChange={(e) => setTab(e.detail.value as Tab)}>
              <IonSegmentButton value="signals">
                <IonLabel>Signals</IonLabel>
              </IonSegmentButton>
              <IonSegmentButton value="settings">
                <IonLabel>Settings</IonLabel>
              </IonSegmentButton>
            </IonSegment>
          </IonToolbar>
        </IonFooter>
      </IonPage>
    </IonApp>
  );
}
