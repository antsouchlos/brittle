import { Group, Panel, Separator } from 'react-resizable-panels';
import styles from './LibraryTabContent.module.css';

function LibraryTabContent() {
    return (
        <Group style={{ height: '100%', width: '100%' }}>
            <Panel defaultSize={33} minSize={15}>
                <div>Library navigation (tree, filters…)</div>
            </Panel>
            <Separator className={styles.panelSeparator} />
            <Panel defaultSize={34} minSize={20}>
                <div>Main viewer (PDF, preview…)</div>
            </Panel>
            <Separator className={styles.panelSeparator} />
            <Panel defaultSize={33} minSize={15}>
                <div>Details / metadata panel</div>
            </Panel>
        </Group>
    );
}

export default LibraryTabContent;
