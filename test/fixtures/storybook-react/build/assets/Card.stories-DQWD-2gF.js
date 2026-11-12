import{R as a}from"./index-D4H_InIO.js";import{C as m}from"./Card-TOiEpQWc.js";const y={title:"Pages/Card",component:m},e={args:{title:"Billing",children:a.createElement("p",null,"Your plan renews on 1 January.")}},r={args:{title:"Phone",children:a.createElement("p",null,"Only at phone width.")},parameters:{designKit:{widths:[390]}},play:async()=>{if(window.innerWidth>600)throw new Error("phone element never appeared")}},n={args:{title:"Broken",children:a.createElement("p",null,"Never captured.")},parameters:{designKit:{widths:[390]}},play:async()=>{throw new Error("broken at every width")}};var t,o,s;e.parameters={...e.parameters,docs:{...(t=e.parameters)==null?void 0:t.docs,source:{originalSource:`{
  args: {
    title: "Billing",
    children: <p>Your plan renews on 1 January.</p>
  }
}`,...(s=(o=e.parameters)==null?void 0:o.docs)==null?void 0:s.source}}};var i,l,p;r.parameters={...r.parameters,docs:{...(i=r.parameters)==null?void 0:i.docs,source:{originalSource:`{
  args: {
    title: "Phone",
    children: <p>Only at phone width.</p>
  },
  parameters: {
    designKit: {
      widths: [390]
    }
  },
  play: async () => {
    if (window.innerWidth > 600) throw new Error("phone element never appeared");
  }
}`,...(p=(l=r.parameters)==null?void 0:l.docs)==null?void 0:p.source}}};var d,c,h;n.parameters={...n.parameters,docs:{...(d=n.parameters)==null?void 0:d.docs,source:{originalSource:`{
  args: {
    title: "Broken",
    children: <p>Never captured.</p>
  },
  parameters: {
    designKit: {
      widths: [390]
    }
  },
  play: async () => {
    throw new Error("broken at every width");
  }
}`,...(h=(c=n.parameters)==null?void 0:c.docs)==null?void 0:h.source}}};const g=["Default","PhoneOnly","PhoneOnlyBroken"];export{e as Default,r as PhoneOnly,n as PhoneOnlyBroken,g as __namedExportsOrder,y as default};
