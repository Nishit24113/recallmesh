import React from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";

/**
 * Presentational provenance-DAG view. Nodes/edges are generated from on-chain
 * lot data by buildGraph() and recoloured by lot status (active/quarantined/recalled).
 */
export default function ProvenanceGraph({ nodes, edges }) {
  return (
    <ReactFlow nodes={nodes} edges={edges} fitView proOptions={{ hideAttribution: true }}>
      <Background color="#2a3344" gap={18} />
      <MiniMap pannable zoomable style={{ background: "#0f1420" }} />
      <Controls />
    </ReactFlow>
  );
}
