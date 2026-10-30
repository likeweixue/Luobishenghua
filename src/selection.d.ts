export class Selection {
  [key: string]: any;
  constructor(w: number, h: number);
  active: boolean;
  mask: HTMLCanvasElement;
}
