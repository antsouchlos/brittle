import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FileText } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';

// Types
interface TreeNodeData {
  id: string;
  name: string;
  children?: TreeNodeData[];
  type?: string;
  description?: string;
  status?: string;
}

interface TreeNodeProps {
  node: TreeNodeData;
  depth: number;
  selectedId: string | undefined;
  onSelect: (node: TreeNodeData) => void;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
}

interface PropertyRowProps {
  label: string;
  value: string;
}

// Sample data — replace with whatever your tree represents
const initialTree: TreeNodeData[] = [
  {
    id: '1',
    name: 'Projects',
    children: [
      {
        id: '1-1',
        name: 'Website Redesign',
        children: [
          { id: '1-1-1', name: 'Homepage', type: 'page', description: 'Main landing page', status: 'In progress' },
          { id: '1-1-2', name: 'About', type: 'page', description: 'About us page', status: 'Done' },
        ],
      },
      {
        id: '1-2',
        name: 'Mobile App',
        children: [
          { id: '1-2-1', name: 'Login Flow', type: 'flow', description: 'User authentication', status: 'In review' },
        ],
      },
    ],
  },
  {
    id: '2',
    name: 'Archived',
    children: [
      { id: '2-1', name: 'Old Logo Concepts', type: 'asset', description: 'Legacy brand work', status: 'Archived' },
    ],
  },
];

function TreeNode({ node, depth, selectedId, onSelect, expandedIds, toggleExpand }: TreeNodeProps) {
  const hasChildren = !!node.children && node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;

  return (
    <div>
      <div
        onClick={() => {
          onSelect(node);
          if (hasChildren) toggleExpand(node.id);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          paddingLeft: 8 + depth * 16,
          cursor: 'pointer',
          background: isSelected ? '#e0e7ff' : 'transparent',
          color: isSelected ? '#1e3a8a' : '#1f2937',
          fontSize: 14,
          userSelect: 'none',
        }}
        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = '#f3f4f6'; }}
        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
      >
        {hasChildren ? (
          isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : (
          <span style={{ width: 14 }} />
        )}
        {hasChildren ? <Folder size={14} /> : <FileText size={14} />}
        <span>{node.name}</span>
      </div>
      {hasChildren && isExpanded && node.children!.map((child) => (
        <TreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
          expandedIds={expandedIds}
          toggleExpand={toggleExpand}
        />
      ))}
    </div>
  );
}

export default function ThreePaneLayout() {
  const [selected, setSelected] = useState<TreeNodeData | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(['1', '1-1']));

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleStyle: React.CSSProperties = {
    width: 4,
    background: '#e5e7eb',
    cursor: 'col-resize',
  };

  return (
    <div style={{
      height: '100vh',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <Group orientation="horizontal" style={{ height: '100%' }}>
        <Panel defaultSize="20%" minSize="10%" maxSize="40%">
          <aside style={{ height: '100%', overflow: 'auto', background: '#fafafa' }}>
            <div style={{ padding: '12px 16px', fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Explorer
            </div>
            {initialTree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                selectedId={selected?.id}
                onSelect={setSelected}
                expandedIds={expandedIds}
                toggleExpand={toggleExpand}
              />
            ))}
          </aside>
        </Panel>

        <Separator style={handleStyle} />

        <Panel defaultSize="60%" minSize="30%">
          <main style={{ height: '100%', overflow: 'auto', padding: 32 }}>
            {selected ? (
              <>
                <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>{selected.name}</h1>
                <p style={{ color: '#6b7280', marginTop: 8 }}>
                  {selected.description || 'No description available.'}
                </p>
                <div style={{ marginTop: 24, padding: 16, background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                  Center content goes here. Drop in an editor, viewer, or whatever this node represents.
                </div>
              </>
            ) : (
              <div style={{ color: '#9ca3af' }}>Select an item from the tree to view it.</div>
            )}
          </main>
        </Panel>

        <Separator style={handleStyle} />

        <Panel defaultSize="20%" minSize="10%" maxSize="40%">
          <aside style={{ height: '100%', overflow: 'auto', background: '#fafafa', padding: '12px 16px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 16 }}>
              Properties
            </div>
            {selected ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
                <PropertyRow label="ID" value={selected.id} />
                <PropertyRow label="Name" value={selected.name} />
                <PropertyRow label="Type" value={selected.type || 'folder'} />
                <PropertyRow label="Status" value={selected.status || '—'} />
              </div>
            ) : (
              <div style={{ color: '#9ca3af', fontSize: 13 }}>Nothing selected.</div>
            )}
          </aside>
        </Panel>
      </Group>
    </div>
  );
}

function PropertyRow({ label, value }: PropertyRowProps) {
  return (
    <div>
      <div style={{ color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ color: '#1f2937' }}>{value}</div>
    </div>
  );
}
