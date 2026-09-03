const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

export function normalizeKeyEvent(event: KeyboardEvent): string | null {
    if (MODIFIER_KEYS.has(event.key)) {
        return null;
    }

    // Ignore alt/meta combinations so they can't trigger bare-key bindings
    // (e.g. Alt+j must not move the tree).
    if (event.altKey || event.metaKey) {
        return null;
    }

    // Some WebKit builds report key='Unidentified' for Shift+Tab, so key off
    // the physical code instead.
    if (event.key === 'Tab' || event.code === 'Tab') {
        return event.shiftKey ? 'Shift+Tab' : 'Tab';
    }

    if (event.ctrlKey && event.key.length === 1) {
        return 'Ctrl+' + event.key;
    }

    return event.key;
}

export class KeymapStateMachine<Action> {
    private m_keymap: Array<[string, Action]>;
    private m_current_string: string = "";
    private m_current_candidates: number[] = [];

    constructor(keymap: Array<[string, Action]>) {
        this.m_keymap = keymap;

        for (let i = 0; i < keymap.length; i++) {
            for (let j = 0; j < keymap.length; j++) {
                if (i !== j && keymap[j][0].startsWith(keymap[i][0])) {
                    // TODO: Properly handle this error 
                    throw new Error(`Keymap conflict: "${keymap[i][0]}" is a prefix of "${keymap[j][0]}"`);
                }
            }
        }

        this.m_current_candidates = Array.from(this.m_keymap.keys());
    }

    public feed(key: string): Action | null {
        this.m_current_string += key;

        // console.log(`${key} -> ${this.m_current_string}`)

        this.m_current_candidates = this.m_current_candidates.filter(
            (idx: number) => this.m_keymap[idx][0].startsWith(this.m_current_string)
        )

        if (this.m_current_candidates.length === 1) {
            let candidate = this.m_keymap[this.m_current_candidates[0]];

            if (candidate[0] == this.m_current_string) {
                let result = candidate[1];
                this.abort();
                return result;
            }
        } else if (this.m_current_candidates.length === 0) {
            this.abort();
        }

        return null;
    }

    public abort(): void {
        this.m_current_string = "";
        this.m_current_candidates = Array.from(this.m_keymap.keys());
    }
}
