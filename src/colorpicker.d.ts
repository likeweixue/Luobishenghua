export function normalizeHex(input: string): string;
export function hexToRgb(hex: string): { r: number; g: number; b: number };
export function rgbToHex(r: number, g: number, b: number): string;
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number };
export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number };
export function hsvToHex(h: number, s: number, v: number): string;
export function openColorPicker(initial: string, opts?: any): any;
