import cytoscape, { type Core, type ElementDefinition, type LayoutOptions, type StylesheetJson } from "cytoscape";
import fcose from "cytoscape-fcose";
import { useEffect, useRef } from "react";

cytoscape.use(fcose);

const KIND_COLORS: Record<string, string> = {
  file: "#8a93a6",
  package: "#a77bf3",
  class: "#f5a623",
  interface: "#50c4b4",
  function: "#5b8def",
  method: "#7ed6a5",
};

const STYLE: StylesheetJson = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "font-size": 11,
      color: "#d8dbe2",
      "text-valign": "bottom",
      "text-margin-y": 4,
      "text-wrap": "wrap",
      "text-max-width": "220px",
      width: 16,
      height: 16,
      "background-color": "#8a93a6",
    },
  },
  ...Object.entries(KIND_COLORS).map(([kind, color]) => ({
    selector: `node[kind="${kind}"]`,
    style: { "background-color": color },
  })),
  { selector: 'node[kind="package"]', style: { shape: "round-rectangle" } },
  { selector: 'node[kind="interface"]', style: { shape: "diamond" } },
  { selector: 'node[kind="class"]', style: { shape: "hexagon" } },
  { selector: "node[weight]", style: { width: "mapData(weight, 0, 25, 14, 48)", height: "mapData(weight, 0, 25, 14, 48)" } },
  {
    selector: 'node[kind="dir"]',
    style: {
      shape: "round-rectangle",
      "background-color": "#ffffff",
      "background-opacity": 0.04,
      "border-width": 1,
      "border-color": "#3a3f4b",
      "text-valign": "top",
      "text-margin-y": -4,
      color: "#8a93a6",
      padding: "14px",
    },
  },
  { selector: "node[?focus]", style: { width: 26, height: 26, "font-weight": "bold", "font-size": 13 } },
  {
    selector: "edge",
    style: {
      width: "mapData(count, 1, 10, 1, 4)",
      "line-color": "#4a5060",
      "target-arrow-color": "#4a5060",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.8,
      "curve-style": "bezier",
    },
  },
  { selector: "node:selected", style: { "border-width": 3, "border-color": "#ffd166" } },
  { selector: "edge.highlight", style: { "line-color": "#ffd166", "target-arrow-color": "#ffd166", "z-index": 10 } },
  { selector: "node.faded", style: { opacity: 0.25 } },
];

interface Props {
  elements: ElementDefinition[];
  layout: LayoutOptions;
  selectedId?: string;
  onSelect(id: string): void;
}

export function GraphView({ elements, layout, selectedId, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const cy = cytoscape({ container: container.current, style: STYLE, minZoom: 0.05, maxZoom: 3 });
    cy.on("tap", "node", (event) => {
      const id: string = event.target.id();
      if (!id.startsWith("dir:")) onSelectRef.current(id);
    });
    cyRef.current = cy;
    return () => cy.destroy();
  }, []);

  useEffect(() => {
    const cy = cyRef.current!;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    cy.layout(layout).run();
    cy.fit(undefined, 40);
  }, [elements, layout]);

  useEffect(() => {
    const cy = cyRef.current!;
    cy.batch(() => {
      cy.elements().unselect().removeClass("highlight faded");
      const node = selectedId ? cy.getElementById(selectedId) : undefined;
      if (!node?.nonempty()) return;
      node.select();
      node.connectedEdges().addClass("highlight");
      // Dim everything not directly related to the selection.
      const related = node.closedNeighborhood().nodes();
      cy.nodes().not(related).not('[kind="dir"]').addClass("faded");
    });
  }, [selectedId, elements]);

  return <div className="graph" ref={container} />;
}
