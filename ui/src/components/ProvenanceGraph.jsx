import React from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";

/**
 * Presentational provenance-DAG view. Nodes/edges are generated from on-chain
 * lot data by buildGraph() and recoloured by lot status (active/quarantined/recalled).
 */
export default function ProvenanceGraph({ nodes, edges }) {
  return (
    <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.2 }} proOptions={{ hideAttribution: true }}>
      <Background color="#2a3344" gap={18} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => n.style?.background}
        maskColor="rgba(15,20,32,.7)"
        style={{ background: "#19202e", width: 140, height: 90 }}
      />
      <Controls />
    </ReactFlow>
  );
}
