import type {
  EnsureOffscreenMessage,
  EnsureOffscreenResponse,
  EngineLanguageId,
  OffscreenIdleProbeResponse,
  ReviewPromptRuntimeResponse,
} from '../utils/protocol';
import {
  isActionStateMessage,
  isOffscreenIdleControlMessage,
  isReviewPromptRuntimeMessage,
} from '../utils/protocol';
import { OffscreenDocumentController } from '../lib/offscreen/document-controller';
import { performanceLog } from '../lib/observability/performance-log';
import { injectActionPanel, PANEL_PAGE } from '../lib/panel/action-panel';
import { ReviewPromptStore } from '../lib/review/review-prompt-store';
import { chromeWebStoreReviewUrl } from '../lib/review/chrome-web-store';

const OFFSCREEN_PATH = '/offscreen.html';
const ICON_SIZES = [16, 24, 32, 48, 128] as const;

const ACTIVE_ICON = Object.fromEntries(
  ICON_SIZES.map((size) => [size, `icon/${size}.png`]),
);
const INACTIVE_ICON = Object.fromEntries(
  ICON_SIZES.map((size) => [size, `icon/inactive/${size}.png`]),
);

export default defineBackground(() => {
  const reviewPromptStore = new ReviewPromptStore();
  /** Per-tab engine states; the toolbar icon is coloured while any is running. */
  const engineStatesByTab = new Map<number, Map<EngineLanguageId, boolean>>();

  function syncActionIcon(tabId: number): void {
    const states = engineStatesByTab.get(tabId);
    const active = states ? [...states.values()].some(Boolean) : false;
    void browser.action
      .setIcon({ tabId, path: active ? ACTIVE_ICON : INACTIVE_ICON })
      .catch(() => {
        // The tab can disappear between the status push and this call.
      });
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    engineStatesByTab.delete(tabId);
  });

  /**
   * The action declares no default popup: on ordinary pages the click injects
   * a floating, rounded, draggable panel into the page itself; on pages that
   * reject injection (chrome://, the Web Store, PDFs, …) we set the popup
   * dynamically and open the plain native rectangle instead.
   */
  browser.action.onClicked.addListener((tab) => {
    void handleActionClick(tab.id);
  });

  async function handleActionClick(tabId: number | undefined): Promise<void> {
    if (tabId === undefined) return;
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        func: injectActionPanel,
        args: [browser.runtime.getURL(PANEL_PAGE)],
      });
      return;
    } catch {
      // Restricted page: fall through to the native popup.
    }
    try {
      await browser.action.setPopup({ popup: PANEL_PAGE });
      await openNativePopup();
    } catch (error) {
      performanceLog('warn', 'action.nativePopup.failed', {
        errorName: error instanceof Error ? error.name : 'Error',
      });
    } finally {
      // Keep the click intercepted for the next tab.
      void browser.action.setPopup({ popup: '' }).catch(() => {});
    }
  }

  async function openNativePopup(): Promise<void> {
    const api = browser.action as unknown as {
      openPopup?: () => Promise<void>;
    };
    if (!api.openPopup) throw new Error('action.openPopup unavailable');
    await api.openPopup();
  }


  async function hasOffscreenDocument(): Promise<boolean> {
    const documentUrl = browser.runtime.getURL(OFFSCREEN_PATH);
    const contexts = await browser.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl],
    });

    return contexts.length > 0;
  }

  const controller = new OffscreenDocumentController({
    hasDocument: hasOffscreenDocument,
    createDocument: () =>
      browser.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS'],
        justification: 'Hosts language analysis workers',
      }),
    closeDocument: () => browser.offscreen.closeDocument(),
    probeIdle: () =>
      browser.runtime.sendMessage({
        type: 'OFFSCREEN_IDLE',
        action: 'probe',
      }) as Promise<OffscreenIdleProbeResponse | undefined>,
  });

  browser.runtime.onMessage.addListener(
    (
      message: EnsureOffscreenMessage | unknown,
      sender,
      sendResponse: (
        response: EnsureOffscreenResponse | ReviewPromptRuntimeResponse,
      ) => void,
    ) => {
      if (isActionStateMessage(message)) {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return false;
        const states = engineStatesByTab.get(tabId) ?? new Map();
        states.set(message.language, message.active);
        engineStatesByTab.set(tabId, states);
        syncActionIcon(tabId);
        return false;
      }

      if (isReviewPromptRuntimeMessage(message)) {
        if (sender.id !== browser.runtime.id) return false;
        const operation =
          message.action === 'qualified-session'
            ? reviewPromptStore
                .recordQualifiedSession()
                .then((eligible) => ({ ok: true, eligible }) as const)
            : reviewPromptStore.claim().then(
                (claimed) =>
                  ({
                    ok: true,
                    claimed,
                    ...(claimed
                      ? { reviewUrl: chromeWebStoreReviewUrl(browser.runtime.id) }
                      : {}),
                  }) as const,
              );
        void operation.then(sendResponse, (error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return true;
      }

      if (
        isOffscreenIdleControlMessage(message) &&
        message.action === 'candidate'
      ) {
        if (sender.url !== browser.runtime.getURL(OFFSCREEN_PATH)) return false;
        const startedAt = performance.now();
        void controller.closeIfStillIdle().then(
          (closed) => {
            performanceLog('info', 'offscreen.close.checked', {
              idle: closed,
              closed,
              durationMs: Math.round(performance.now() - startedAt),
            });
          },
          (error: unknown) => {
            performanceLog('error', 'offscreen.close.failed', {
              durationMs: Math.round(performance.now() - startedAt),
              errorName: error instanceof Error ? error.name : 'Error',
            });
            console.error('[LeetSense] offscreen close failed', error);
          },
        );
        return false;
      }
      if (
        typeof message !== 'object' ||
        message === null ||
        !('type' in message) ||
        message.type !== 'ENSURE_OFFSCREEN'
      ) {
        return false;
      }

      const startedAt = performance.now();
      void controller.ensure().then(
        (created) => {
          performanceLog('info', 'offscreen.ensure.complete', {
            durationMs: Math.round(performance.now() - startedAt),
            outcome: 'ok',
            created,
          });
          sendResponse({ ok: true });
        },
        async (error: unknown) => {
          // A second extension context can win the create race. Verify the
          // document before surfacing a failure.
          try {
            if (await hasOffscreenDocument()) {
              performanceLog('info', 'offscreen.ensure.complete', {
                durationMs: Math.round(performance.now() - startedAt),
                outcome: 'race-won-elsewhere',
              });
              sendResponse({ ok: true });
              return;
            }
          } catch {
            // Preserve the original createDocument error below.
          }

          performanceLog('error', 'offscreen.ensure.failed', {
            durationMs: Math.round(performance.now() - startedAt),
            outcome: 'error',
            errorName: error instanceof Error ? error.name : 'Error',
          });
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );

      return true;
    },
  );
});
