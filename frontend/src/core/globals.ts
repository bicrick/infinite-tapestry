// window.Tapestry* globals: the contract between the viewer and the page modules that are still plain JS
// (intro, offline, mobile, social, fun) plus the test harness. Same names and shapes as before the migration.
import type { ClientMsg } from "./protocol";

export interface TapestrySocialApi {
  enabled?: boolean; isAdmin(): boolean; token(): string | null | undefined;
  hasRef?(): boolean; submitIdea(text: string, key: string): Promise<boolean> | boolean;
  myVotes?(): Set<unknown>; etaLabel?(eta: number): string; heart?(id: unknown, votes: unknown): string; warmSend?(): void;
}
export interface TapestryOpsApi { report(type: string, ms?: number | null, d?: Record<string, string>): void; flush(): void }
/** View hooks (intro, mobile, fun, offline). Filled in by the viewer in stages, as before. */
export type TapestryViewApi = Record<string, unknown>;

declare global {
  interface Window {
    TapestryOps?: TapestryOpsApi;
    TapestrySocial?: TapestrySocialApi;
    TapestryView: TapestryViewApi;
    TapestryWS?: { send(o: ClientMsg): void; toast(h: string, ms?: number): void; esc(x: unknown): string };
    TapestryCredit?: (by: unknown, origin?: string | null, opts?: { guestNames?: boolean }) => string;
    TapestryIdeaTitle?: (text: unknown, by: unknown, image?: unknown) => string;
    TapestryJump?: (idx: number) => void;
    TapestrySeek?: (from: number, to?: number | null) => void;
    TapestryReplayStart: (maxIndex: number, rand?: () => number) => number;
    TapestrySaver?: { on: boolean };
    TapestryAmbient?: (on: boolean) => void;
    TapestryCompose?: (on: boolean) => void;
    Odometer?: (el: HTMLElement) => { set(n: number): void };
    __tapestryWsOpen?: boolean;
  }
}
export {};
