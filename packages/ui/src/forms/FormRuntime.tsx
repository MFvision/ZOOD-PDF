import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppDispatch, useServices } from '../state/AppContext';
import { formScope, watchActiveDocument, watchCommits } from './embedForms';
import { changedValues, hasScripts, recalcInput, rejectionKey } from './formTypes';
import type { FormModel, RecalcOutcome } from './formTypes';

/**
 * The form of the open file, read by Warraq's core (`forms.inspect`) each
 * time EmbedPDF is given new bytes, and its scripts run as the form is filled.
 *
 * PDFium runs no form JavaScript, so without this a total never followed its
 * rows. Every value EmbedPDF reports is handed to the core's interpreter of
 * the built-in form functions (`forms.recalculate`) — never to a JavaScript
 * engine — and the calculated fields are set in the view. A value is checked
 * (its keystroke and validation scripts) when it is committed, which EmbedPDF
 * signals as its input loses the focus; a refused one goes back to
 * what it was, with a notice, as other form readers do.
 */
interface FormRuntime {
  /** The open file's form; null before it is read, or with no file. */
  model: FormModel | null;
}

const FormContext = createContext<FormRuntime>({ model: null });

export function useFormRuntime(): FormRuntime {
  return useContext(FormContext);
}

export function FormRuntimeProvider({ children }: { children: ReactNode }) {
  const services = useServices();
  const dispatch = useAppDispatch();
  const { client, documentBytes, documentPassword, embedRegistry } = services;
  // The form as read, with the bytes it was read from: a model of other
  // bytes is not this file's.
  const [read, setRead] = useState<{ bytes: ArrayBuffer; model: FormModel | null } | null>(null);
  const model = read && read.bytes === documentBytes ? read.model : null;

  useEffect(() => {
    if (!documentBytes) return;
    let cancelled = false;
    client
      .callStatic<FormModel>('forms.inspect', { password: documentPassword ?? null }, [
        documentBytes.slice(0),
      ])
      .then(
        ({ result }) => {
          if (!cancelled) setRead({ bytes: documentBytes, model: result });
        },
        () => {
          if (!cancelled) setRead({ bytes: documentBytes, model: null });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [client, documentBytes, documentPassword]);

  // EmbedPDF opens a changed file as a new document: the form to follow.
  const [active, setActive] = useState(0);
  useEffect(
    () =>
      embedRegistry ? watchActiveDocument(embedRegistry, () => setActive((n) => n + 1)) : undefined,
    [embedRegistry],
  );

  // The values last accepted, to go back to when one is refused.
  const accepted = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!embedRegistry || !model || !model.fields.some(hasScripts)) return;
    const scope = formScope(embedRegistry);
    if (!scope) return;
    accepted.current = { ...scope.getFormValues() };
    let running = false;
    // Runs asked for while one was running: commits by name, `null` for a
    // plain recalculation.
    const queue: (string | null)[] = [];
    let closed = false;

    const recalculate = async (changed: string | null): Promise<void> => {
      if (running) {
        if (!queue.includes(changed)) queue.push(changed);
        return;
      }
      running = true;
      try {
        const values = scope.getFormValues();
        const { result } = await client.callStatic<RecalcOutcome>('forms.recalculate', {
          fields: recalcInput(model, values),
          order: model.order,
          changed,
        });
        if (closed) return;
        if (changed && result.rejected) {
          const previous = accepted.current[changed] ?? '';
          await scope
            .setFormValues({ [changed]: previous })
            .toPromise()
            .catch(() => false);
          dispatch({ type: 'TOAST', key: rejectionKey(result.rejected) });
          return;
        }
        const next: Record<string, string> = { ...result.values };
        if (changed && result.normalized !== null) next[changed] = result.normalized;
        const set = changedValues(next, values);
        if (Object.keys(set).length > 0)
          await scope
            .setFormValues(set)
            .toPromise()
            .catch(() => false);
        // A value being typed is not accepted until it is committed.
        accepted.current = { ...accepted.current, ...set };
        if (changed) accepted.current[changed] = next[changed] ?? values[changed] ?? '';
      } catch {
        /* the core could not run it: the values stay as they are */
      } finally {
        running = false;
        const next = queue.shift();
        if (next !== undefined && !closed) void recalculate(next);
      }
    };

    // A committed value reaches EmbedPDF's engine a moment after its input
    // loses the focus: it is checked once it has — its value-change event —
    // or, when nothing changed, after a short wait.
    const commits = new Map<string, number>();
    const commit = (name: string) => {
      window.clearTimeout(commits.get(name));
      commits.delete(name);
      void recalculate(name);
    };
    const unsubscribe = [
      // Every value EmbedPDF writes is calculated with.
      scope.onFieldValueChange((event) => {
        const name = event.widget.field?.name;
        if (name && commits.has(name)) commit(name);
        else void recalculate(null);
      }),
      watchCommits((name) => {
        window.clearTimeout(commits.get(name));
        commits.set(
          name,
          window.setTimeout(() => commit(name), 400),
        );
      }),
    ];
    return () => {
      closed = true;
      commits.forEach((timer) => window.clearTimeout(timer));
      unsubscribe.forEach((off) => off());
    };
  }, [client, dispatch, embedRegistry, model, active]);

  const value = useMemo(() => ({ model }), [model]);
  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
}
