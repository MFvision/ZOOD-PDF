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
      // Read on every file opened: a copy only where the core takes the buffer.
      .callStatic<FormModel>('forms.inspect', { password: documentPassword ?? null }, [
        client.takesBuffers ? documentBytes.slice(0) : documentBytes,
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
    /**
     * One run: a commit of `changed` — with `typed`, the text it held when
     * it was committed, for a field typed into — or, with `changed` null,
     * a plain recalculation.
     */
    interface Run {
      changed: string | null;
      typed?: string;
    }
    // Runs asked for while one was running.
    const queue: Run[] = [];
    let closed = false;

    const recalculate = async (run: Run): Promise<void> => {
      if (running) {
        // One plain recalculation is enough; a field's later commit replaces its earlier one.
        const same = queue.findIndex((queued) => queued.changed === run.changed);
        if (same < 0) queue.push(run);
        else if (run.changed !== null) queue[same] = run;
        return;
      }
      running = true;
      const { changed, typed } = run;
      try {
        const current = scope.getFormValues();
        // The value committed is what is checked, even when the field has
        // moved on since: typed quickly, a value was committed and the next
        // one typed before the engine had the first — which was then never
        // checked, and a refused second one went back to empty.
        const values = changed !== null && typed !== undefined ? { ...current, [changed]: typed } : current;
        const { result } = await client.callStatic<RecalcOutcome>('forms.recalculate', {
          fields: recalcInput(model, values),
          order: model.order,
          changed,
        });
        if (closed) return;
        // The person may be typing there again: what they type is not overwritten.
        const movedOn = changed !== null && typed !== undefined && (scope.getFormValues()[changed] ?? '') !== typed;
        if (changed && result.rejected) {
          const previous = accepted.current[changed] ?? '';
          if (!movedOn)
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
        if (movedOn && changed) delete set[changed];
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
    // or, when nothing changed, after a short wait. A second commit of the
    // same field before then does not drop the first: it is checked at once.
    const commits = new Map<string, { timer: number; typed?: string }>();
    const commit = (name: string) => {
      const pending = commits.get(name);
      window.clearTimeout(pending?.timer);
      commits.delete(name);
      void recalculate({ changed: name, typed: pending?.typed });
    };
    const unsubscribe = [
      // Every value EmbedPDF writes is calculated with.
      scope.onFieldValueChange((event) => {
        const name = event.widget.field?.name;
        if (name && commits.has(name)) commit(name);
        else void recalculate({ changed: null });
      }),
      watchCommits((name, typed) => {
        if (commits.has(name)) commit(name);
        commits.set(name, { timer: window.setTimeout(() => commit(name), 400), typed });
      }),
    ];
    return () => {
      closed = true;
      commits.forEach((pending) => window.clearTimeout(pending.timer));
      unsubscribe.forEach((off) => off());
    };
  }, [client, dispatch, embedRegistry, model, active]);

  const value = useMemo(() => ({ model }), [model]);
  return <FormContext.Provider value={value}>{children}</FormContext.Provider>;
}
