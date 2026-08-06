export type RenderWorkPriority = 'interactive-primary-still' | 'interactive-secondary-still' | 'export-recovery' | 'foreground-export-video' | 'background-video';
const order: Record<RenderWorkPriority, number> = { 'interactive-primary-still': 0, 'interactive-secondary-still': 1, 'export-recovery': 2, 'foreground-export-video': 3, 'background-video': 4 };
interface Queued { priority: RenderWorkPriority; run: () => Promise<unknown>; resolve: (v: unknown)=>void; reject: (e: unknown)=>void; }
const q: Queued[] = [];
let running = false;
async function pump(){
  if(running) return;
  running = true;
  while(q.length){
    q.sort((a,b)=> order[a.priority]-order[b.priority]);
    const item = q.shift()!;
    try{ const v = await item.run(); item.resolve(v); } catch(e){ item.reject(e); }
    // yield between artifacts
    await Promise.resolve();
  }
  running = false;
}
export const renderWorkCoordinator = {
  schedule<T>(priority: RenderWorkPriority, work: () => Promise<T>, _opts?: {reason?: string}): Promise<T> {
    return new Promise<T>((resolve, reject)=>{
      q.push({ priority, run: work as ()=>Promise<unknown>, resolve: resolve as (v: unknown)=>void, reject });
      void pump();
    });
  },
  inspectForTests(){ return { queue: q.length, running }; },
  resetForTests(){ q.length = 0; running = false; }
};
