// 共享类型：GPU 合成器与瓦片层的边界。
import type { TileSurface } from './tiles.js';

export interface GpuMask {
  surface: TileSurface;
  enabled?: boolean;
}

export interface GpuLayerNode {
  id: string | number;
  type: 'layer' | 'group';
  visible: boolean;
  opacity: number;
  blend?: string | null;
  clipping?: boolean;
  mask?: GpuMask | null;
  surface?: TileSurface;
  children?: GpuLayerNode[];
}

export interface GpuLayerStack {
  layers: GpuLayerNode[];
  w: number;
  h: number;
  activeId?: string | number | null;
}

export interface ViewState {
  scale: number;
  rotation?: number;
  tx: number;
  ty: number;
}

export interface GpuDab {
  x: number;
  y: number;
  size: number;
  alpha: number;
}

export interface BrushPreview {
  layerId: string | number;
  stamp: HTMLCanvasElement;
  dabs: GpuDab[];
}

export interface AnalyzeInfo {
  ok: boolean;
  complex: boolean;
  tiles: number;
  bytes: number;
  reason: string;
}

export interface GpuFbo {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
  inUse: boolean;
}
