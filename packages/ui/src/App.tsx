import './styles/tokens.css';
import './styles/fonts.css';
import './styles/base.css';
import './styles/components.css';
import './shell/shell.css';
import './shell/panes.css';
import './viewer/viewer.css';
import './edit/edit.css';
import './home/home.css';
import { I18nProvider } from './i18n/I18nProvider';
import type { Lang } from './i18n/messages';
import { FormRuntimeProvider } from './forms/FormRuntime';
import { Shell } from './shell/Shell';
import { SignaturesProvider } from './signatures/SignaturesContext';
import { AppProvider } from './state/AppContext';

export interface AppProps {
  /** Forces the UI language; by default Arabic for ar-* browsers, else English. */
  initialLang?: Lang;
}

/** The whole Warraq product shell; hosts only mount this. */
export function App({ initialLang }: AppProps) {
  return (
    <I18nProvider initialLang={initialLang}>
      <AppProvider>
        <SignaturesProvider>
          <FormRuntimeProvider>
            <Shell />
          </FormRuntimeProvider>
        </SignaturesProvider>
      </AppProvider>
    </I18nProvider>
  );
}
