import{R as n}from"./index-D4H_InIO.js";import{C as w}from"./Card-TOiEpQWc.js";const B={title:"Hostile/Card",component:w},r={args:{title:"Zero",children:n.createElement("p",null,"Malformed widths.")},parameters:{designKit:{widths:[0]}},play:async()=>{throw new Error("zero widths play")}},s={args:{title:"Busy",children:n.createElement("p",null,"Never settles.")},play:async()=>{for(;;)globalThis.__spins=(globalThis.__spins??0)+1}},t={args:{title:"Busy after render",children:n.createElement("p",null,"Rendered, then held.")},play:async()=>{const e=window.__kit;let a=e.pending;Object.defineProperty(e,"pending",{enumerable:!1,get(){if(e.outcome!=="rendered")return a;for(;;)globalThis.__spins=(globalThis.__spins??0)+1},set(b){a=b}})}},o={args:{title:"Phone only",children:n.createElement("p",null,"Held on desktop.")},parameters:{designKit:{widths:[390]}},render:e=>{if(window.innerWidth>600)for(;;)globalThis.__heldDesktop=(globalThis.__heldDesktop??0)+1;return n.createElement(w,{...e})}};var i,l,d;r.parameters={...r.parameters,docs:{...(i=r.parameters)==null?void 0:i.docs,source:{originalSource:`{
  args: {
    title: "Zero",
    children: <p>Malformed widths.</p>
  },
  parameters: {
    designKit: {
      widths: [0]
    }
  },
  play: async () => {
    throw new Error("zero widths play");
  }
}`,...(d=(l=r.parameters)==null?void 0:l.docs)==null?void 0:d.source}}};var p,c,h;s.parameters={...s.parameters,docs:{...(p=s.parameters)==null?void 0:p.docs,source:{originalSource:`{
  args: {
    title: "Busy",
    children: <p>Never settles.</p>
  },
  play: async () => {
    // The write keeps the minifier from dropping the loop.
    for (;;) globalThis.__spins = (globalThis.__spins ?? 0) + 1;
  }
}`,...(h=(c=s.parameters)==null?void 0:c.docs)==null?void 0:h.source}}};var g,m,u;t.parameters={...t.parameters,docs:{...(g=t.parameters)==null?void 0:g.docs,source:{originalSource:`{
  args: {
    title: "Busy after render",
    children: <p>Rendered, then held.</p>
  },
  play: async () => {
    const kit = window.__kit;
    let pending = kit.pending;
    Object.defineProperty(kit, "pending", {
      enumerable: false,
      get() {
        if (kit.outcome !== "rendered") return pending;
        for (;;) globalThis.__spins = (globalThis.__spins ?? 0) + 1;
      },
      set(value) {
        pending = value;
      }
    });
  }
}`,...(u=(m=t.parameters)==null?void 0:m.docs)==null?void 0:u.source}}};var _,y,f;o.parameters={...o.parameters,docs:{...(_=o.parameters)==null?void 0:_.docs,source:{originalSource:`{
  args: {
    title: "Phone only",
    children: <p>Held on desktop.</p>
  },
  parameters: {
    designKit: {
      widths: [390]
    }
  },
  render: args => {
    if (window.innerWidth > 600) for (;;) globalThis.__heldDesktop = (globalThis.__heldDesktop ?? 0) + 1;
    return <Card {...args} />;
  }
}`,...(f=(y=o.parameters)==null?void 0:y.docs)==null?void 0:f.source}}};const E=["ZeroWidths","Busy","BusyAfterRender","PhoneOnlyHeldDesktop"];export{s as Busy,t as BusyAfterRender,o as PhoneOnlyHeldDesktop,r as ZeroWidths,E as __namedExportsOrder,B as default};
