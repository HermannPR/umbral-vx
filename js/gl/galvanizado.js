// El respaldo WebGL2 usa el mismo anillo y la misma aproximación espacial que WebGPU.
import { VS, program, target, upload, freeTarget, pass } from './glcore.js';
import { ANILLO, MODOS_GALV } from '../demos/galvanizado-anillo.js';
export { MODOS_GALV };
const HEAD = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D src; uniform vec2 res; out vec4 o;
const vec3 W3 = vec3(0.2126,0.7152,0.0722);
`;
const DOWN = HEAD + `
uniform vec2 lowRes;
void main(){
 vec2 cell=floor(gl_FragCoord.xy);float ls=0.0;
 for(int y=0;y<4;y++)for(int x=0;x<4;x++){
  vec2 uv=(cell+(vec2(x,y)+0.5)/4.0)/lowRes;
  ls+=sqrt(clamp(dot(texture(src,uv).rgb,W3),0.0,1.0));
 }
 o=vec4(ls/16.0,0,0,1);
}`;
const BLUR = HEAD + `
uniform float sigma;uniform vec2 lowRes;
float suave(vec2 uv){
 vec2 delta=sigma*1.732050808/960.0*vec2(1,res.x/res.y);float ls=0.0;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
  float w=(x==0?2.0/3.0:1.0/6.0)*(y==0?2.0/3.0:1.0/6.0);
  ls+=w*texture(src,uv+vec2(x,y)*delta).r;
 }
 return ls;
}
void main(){
 vec2 uv=gl_FragCoord.xy/lowRes,px=1.0/res;
 float gx=.5*(suave(uv+vec2(px.x,0))-suave(uv-vec2(px.x,0)));
 float gy=.5*(suave(uv+vec2(0,px.y))-suave(uv-vec2(0,px.y)));
 o=vec4(suave(uv),clamp(length(vec2(gx,gy))*25.0*res.x/960.0,0.0,1.0),0,1);
}`;
const GRADE = HEAD + `
uniform sampler2D suav,ring;uniform float pal,time;
vec3 row(int i){return texelFetch(ring,ivec2(i,0),0).rgb;}
vec3 tone(int i,int base){float w=.5-.5*cos(6.28318530718*float(i%1024)/1024.0);return mix(row(base),row(base+1),w);}
void main(){
 vec2 uv=gl_FragCoord.xy/res;vec3 raw=texture(src,uv).rgb;
 vec2 lsTilt=texture(suav,uv).rg;float ls=lsTilt.x;
 float ph=6.28318530718*time/9.6,N=pal==5.0?.6:pal==4.0?.8:1.0,tilt=pal==5.0?.05:.03;
 float pos=fract(N*ls+.18*sin(ph)-tilt*lsTilt.y+.06*sin(4.0*uv.x+ph))*1024.0;
 int i=int(floor(pos));float f=fract(pos);
 int j=(i+((f>.5||(f==.5&&i%2==1))?1:0))%1024;
 vec3 unit=row(j),fill=vec3(.008,.008,.035);
 if(pal>5.5){int base=1024+3*(int(pal)-6);unit=mix(tone(i,base),tone(i+1,base),f);unit=1.0+(unit-1.0)*(1.0-.12*pow(sin(3.14159265359*ls),2.0));fill=row(base+2);}
 unit=mix(vec3(dot(unit,W3)),unit,pal<5.5?.6:.85);
 float lg=pow(clamp(dot(raw,W3)*1.2,0.0,1.0),1.15);
 o=vec4(unit*lg+fill*pow(1.0-lg,3.0),1);
}`;
export default class GalvanizadoGL {
  constructor(gl, out, report) {
    this.gl=gl; this.out=out;
    this.raw=target(gl,out.w,out.h);
    this.low=target(gl,Math.ceil(out.w/16),Math.ceil(out.h/16));
    this.blur=target(gl,this.low.w,this.low.h);
    this.ring=target(gl,ANILLO.length/4,1,{fmt:'RGBA32F',filter:false}); upload(gl,this.ring,0,ANILLO);
    this.pipes=[DOWN,BLUR,GRADE].map((fs,i)=>program(gl,VS,fs,report,'galvanizado-'+i));
  }
  run(pal,time) {
    const gl=this.gl,res=[this.out.w,this.out.h],lowRes=[this.low.w,this.low.h];
    pass(gl,this.pipes[0],this.low,{res,lowRes},{src:this.raw.tex});
    pass(gl,this.pipes[1],this.blur,{res,lowRes,sigma:pal===5?14:20},{src:this.low.tex});
    pass(gl,this.pipes[2],this.out,{res,pal,time:time%9.6},{src:this.raw.tex,suav:this.blur.tex,ring:this.ring.tex});
  }
  destroy() { [this.raw,this.low,this.blur,this.ring].forEach(t=>freeTarget(this.gl,t));this.pipes.forEach(p=>this.gl.deleteProgram(p.p)); }
}
