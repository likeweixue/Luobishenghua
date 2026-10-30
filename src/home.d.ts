export const PRESETS: any[];
export function getRecents(): any[];
export function addRecent(entry: any): void;
export function renderRecents(onOpenRecent: (entry: any) => void): void;
export function createHome(opts: any): any;
export function toast(msg: string, ms?: number): void;
