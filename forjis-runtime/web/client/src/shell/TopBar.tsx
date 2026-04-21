/**
 * TopBar — the shell's top navigation strip.
 *
 * Structure (left to right): brand cluster (logo mark + project icon +
 * directory breadcrumbs) and the tab nav (Tasks / Config). The search
 * input and `⌘K` hint were removed per redesign-014 — the mockup carries
 * only the brand cluster and tabs. The absolute project directory is
 * fetched once on mount via `/api/config`; breadcrumbs split that path
 * on `/` or `\` so the final segment (project name) gets accent text
 * and all preceding segments get the muted text token. On mount the
 * component also updates `document.title` to `"Forjis - <projectName>"`
 * so multiple forjis browser tabs are disambiguated at the tab strip.
 *
 * See design.md decision D-3 (redesign-004) and redesign-014 for the
 * project icon + breadcrumb extension.
 */

import type { Component } from 'solid-js';
import { For, createMemo, createSignal, onMount } from 'solid-js';
import { ProjectIcon } from '../components/primitives/ProjectIcon';
import { fetchConfig } from './api';
import { useView, type ViewName } from './ViewContext';
import styles from './TopBar.module.css';

/** Fallback project name used when `/api/config` is unavailable. */
const FALLBACK_PROJECT_NAME = 'forjis';

/**
 * Split an absolute project directory path into ordered, non-empty
 * segments. Accepts both POSIX (`/`) and Windows (`\`) separators so the
 * same rendering code handles both platforms. Empty segments (from a
 * leading separator or doubled separators) are dropped.
 */
function splitProjectDir(projectDir: string): string[] {
  return projectDir.split(/[/\\]/).filter((s) => s.length > 0);
}

/** Join a tab's static class with the active modifier when selected. */
function tabClass(isActive: boolean): string {
  return isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab;
}

/**
 * Props for {@link TabButton}. `name` drives the active check against the
 * shared view signal; `label` is the visible text.
 */
interface TabButtonProps {
  name: ViewName;
  label: string;
}

/** Single tab button. Kept inline so TopBar stays close to its reference. */
const TabButton: Component<TabButtonProps> = (props) => {
  const view = useView();
  const isActive = () => view.activeView() === props.name;
  return (
    <button
      type="button"
      role="tab"
      class={tabClass(isActive())}
      aria-selected={isActive()}
      onClick={() => view.setActiveView(props.name)}
    >
      {props.label}
    </button>
  );
};

/**
 * Top navigation bar. Owns the project-dir fetch and derives both the
 * breadcrumb segments and the document title from the resulting string.
 */
export const TopBar: Component = () => {
  const [projectDir, setProjectDir] = createSignal<string>('');
  const [fallbackName, setFallbackName] = createSignal<string>(FALLBACK_PROJECT_NAME);

  const segments = createMemo<string[]>(() => splitProjectDir(projectDir()));

  onMount(async () => {
    const config = await fetchConfig();
    const dir = config?.projectDir ?? '';
    setProjectDir(dir);
    const firstOrgName = config?.orgs.orgs[0]?.name;
    if (firstOrgName && firstOrgName.length > 0) {
      setFallbackName(firstOrgName);
    }
    const resolvedName =
      dir.length > 0
        ? (splitProjectDir(dir).pop() ?? FALLBACK_PROJECT_NAME)
        : firstOrgName && firstOrgName.length > 0
          ? firstOrgName
          : FALLBACK_PROJECT_NAME;
    document.title = `Forjis - ${resolvedName}`;
  });

  return (
    <header class={styles.topbar}>
      <div class={styles.logo}>
        <img class={styles.logoMark} src="/logo-h.svg" alt="forjis" />
        {projectDir().length > 0 ? (
          <>
            <ProjectIcon projectDir={projectDir()} />
            <nav class={styles.breadcrumbs} aria-label="Project path">
              <For each={segments()}>
                {(segment, index) => {
                  const isLast = () => index() === segments().length - 1;
                  return (
                    <>
                      {index() > 0 && (
                        <span class={styles.breadcrumbSep} aria-hidden="true">
                          /
                        </span>
                      )}
                      <span
                        class={
                          isLast()
                            ? `${styles.breadcrumbSegment} ${styles.breadcrumbSegmentLast}`
                            : styles.breadcrumbSegment
                        }
                      >
                        {segment}
                      </span>
                    </>
                  );
                }}
              </For>
            </nav>
          </>
        ) : (
          <span class={styles.projectName}>{fallbackName()}</span>
        )}
      </div>
      <div class={styles.tabs} role="tablist">
        <TabButton name="tasks" label="Tasks" />
        <TabButton name="config" label="Config" />
      </div>
    </header>
  );
};
