import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { uiLog } from '../core/host-tauri';
import { translate } from '../i18n/messages';
import './crashGuard.css';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  copied: boolean;
}

/** The window's language, without the app's state (which may be what broke). */
function languageNow(): 'ar' | 'en' {
  const lang = document.documentElement.lang || navigator.language || 'ar';
  return lang.toLowerCase().startsWith('en') ? 'en' : 'ar';
}

/**
 * The last guard of a window: a mistake while drawing it shows a short
 * apology with Reload, not a blank white window that only a restart
 * clears. The editor keeps its autosaved copies, so reloading offers them
 * back. What broke goes to the app's log, for a report.
 */
export class CrashGuard extends Component<Props, State> {
  override state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    uiLog(`crash: ${error.name}: ${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 4000));
  }

  private copy = () => {
    const { error } = this.state;
    if (!error) return;
    void navigator.clipboard
      ?.writeText(`${error.name}: ${error.message}\n${error.stack ?? ''}`)
      .then(() => this.setState({ copied: true }), () => undefined);
  };

  override render(): ReactNode {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const lang = languageNow();
    return (
      <div className="crash-guard" role="alert" dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
        <h1>{translate(lang, 'crash.title')}</h1>
        <p>{translate(lang, 'crash.body')}</p>
        <div className="crash-guard-actions">
          <button type="button" className="crash-guard-main" onClick={() => location.reload()}>
            {translate(lang, 'crash.reload')}
          </button>
          <button type="button" onClick={this.copy}>
            {translate(lang, copied ? 'crash.copied' : 'crash.copy')}
          </button>
        </div>
      </div>
    );
  }
}
