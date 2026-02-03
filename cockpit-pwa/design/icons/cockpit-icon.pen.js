// FUGUE Cockpit PWA Icon Design
// Size: 512x512 (base) for multi-resolution export

// Create base canvas
base = I(root, {
  type: "frame",
  name: "cockpit-icon-512",
  width: 512,
  height: 512,
  fill: "#09090b",
  cornerRadius: 0
});

// Outer glow effect
outerGlow = I(base, {
  type: "ellipse",
  name: "outer-glow",
  x: 106,
  y: 106,
  width: 300,
  height: 300,
  fill: {
    type: "radial",
    cx: 150,
    cy: 150,
    r: 150,
    stops: [
      { offset: 0, color: "rgba(99, 102, 241, 0.3)" },
      { offset: 1, color: "rgba(139, 92, 246, 0.1)" }
    ]
  }
});

// Center circle with gradient (main element)
centerCircle = I(base, {
  type: "ellipse",
  name: "center-circle",
  x: 156,
  y: 156,
  width: 200,
  height: 200,
  fill: {
    type: "linear",
    x1: 0,
    y1: 0,
    x2: 200,
    y2: 200,
    stops: [
      { offset: 0, color: "#6366f1" },
      { offset: 1, color: "#8b5cf6" }
    ]
  }
});

// Conductor's baton (orchestration symbol)
baton = I(base, {
  type: "rectangle",
  name: "conductor-baton",
  x: 236,
  y: 180,
  width: 40,
  height: 120,
  fill: "#ffffff",
  cornerRadius: 20,
  rotation: -15
});

// Baton tip
batonTip = I(base, {
  type: "ellipse",
  name: "baton-tip",
  x: 241,
  y: 165,
  width: 30,
  height: 30,
  fill: "#ffffff"
});

// Orchestration waves (3 layers with fading opacity)
wave1 = I(base, {
  type: "path",
  name: "wave-1",
  d: "M 180 340 Q 220 320 256 340 Q 292 360 332 340",
  stroke: "#ffffff",
  strokeWidth: 4,
  fill: "none",
  opacity: 0.4
});

wave2 = I(base, {
  type: "path",
  name: "wave-2",
  d: "M 180 360 Q 220 340 256 360 Q 292 380 332 360",
  stroke: "#ffffff",
  strokeWidth: 4,
  fill: "none",
  opacity: 0.3
});

wave3 = I(base, {
  type: "path",
  name: "wave-3",
  d: "M 180 380 Q 220 360 256 380 Q 292 400 332 380",
  stroke: "#ffffff",
  strokeWidth: 4,
  fill: "none",
  opacity: 0.2
});
