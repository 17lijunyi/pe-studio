export const VERSION: string;
export type MaterialName = 'clearActive'|'regularActive'|'buttonActive'|'clearActiveDark'|'regularActiveDark'|'buttonActiveDark'|'clearInactive'|'regularInactive'|'buttonInactive';
export type SpringName = 'transition'|'scaleUp'|'scaleDownHeight'|'scaleDownWidth'|'bridge'|'kick'|'kickReturn';
export interface MaterialOptions {
  refraction?: number; refractionHeight?: number; blur?: number; dispersion?: number;
  tint?: [number,number,number,number]; rawToCss?: number; blurPackingScale?: number;
  headroomMix?: number; extraSdf?: 'auto'|false|'experimental';
}
export interface GlassMaterial {
  materialName: MaterialName; profile:'recovered'; refraction:number; refractionHeight:number;
  blur:number; dispersion:number; tint:readonly number[]; composite:unknown;
  sdfHighlight?:unknown; vibrancy?:unknown; provenance:Readonly<Record<string,unknown>>;
  limitations:readonly string[];
}
export const MATERIAL_NAMES: readonly MaterialName[];
export function createMaterial(name?:MaterialName,options?:MaterialOptions):Readonly<GlassMaterial>;
export interface PaintSize { width:number; height:number; dpr:number; canvas:HTMLCanvasElement; }
export type BackgroundPainter = (ctx:CanvasRenderingContext2D,size:PaintSize)=>void;
export type BackgroundSource = string|HTMLCanvasElement|OffscreenCanvas|HTMLImageElement|HTMLVideoElement|ImageBitmap|BackgroundPainter|null;
export interface GlassDiagnostics {
  mode:'loading'|'webgl'|'css'; source:string; sourceError:string|null; error:string|null; surfaces:number;
  renderer:Record<string,unknown>|null;
  materials:ReadonlyArray<{name:string|null;provenance:unknown;limitations:readonly string[]}>;
}
export interface LiquidGlassSceneElement extends HTMLElement {
  background:BackgroundSource|undefined;
  materialOptions:MaterialOptions;
  readonly diagnostics:GlassDiagnostics;
  setBackground(source:BackgroundSource):Promise<boolean>;
  updateBackground():void;
  refresh():void;
  destroy():void;
}
export interface LiquidGlassElement extends HTMLElement {
  radius:number;
  materialOptions:MaterialOptions;
}
export function defineLiquidGlass(win?:Window&typeof globalThis):null|{
  LiquidGlassScene:{new():LiquidGlassSceneElement};LiquidGlass:{new():LiquidGlassElement};
};
export interface InteractionState { hovered:boolean; pressed:boolean; keyboard:boolean; scale:number; targetScale:number; reducedMotion:boolean; enabled:boolean; }
export function attachGlassInteraction(element:HTMLElement,options?:{enabled?:boolean;animation?:SpringName|'none';onChange?:(state:InteractionState)=>void}):{destroy():void;setEnabled(value:boolean):void};
export const GLASS_SPRINGS:Readonly<Record<SpringName,{label:string;duration:number;bounce:number}>>;
export interface GlassSurface {element:Element;radius?:number;composite?:unknown;sdfHighlight?:unknown;vibrancy?:unknown;tint?:readonly number[];[key:string]:unknown;}
export class GlassRenderer {
  constructor(canvas:HTMLCanvasElement,options:{background:HTMLCanvasElement|OffscreenCanvas;surfaces?:()=>GlassSurface[];backgroundKernel?:'variable13'|'tile2'|'webgl';onError?:(error:Error)=>void;onRestore?:(renderer:GlassRenderer)=>void});
  readonly diagnostics:Record<string,unknown>;
  render():boolean;uploadBackground():boolean;start():boolean;stop():void;destroy():void;
}
declare global {
  interface HTMLElementTagNameMap {
    'liquid-glass-scene':LiquidGlassSceneElement;
    'liquid-glass':LiquidGlassElement;
  }
}
