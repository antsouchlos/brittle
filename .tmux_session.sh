#!/bin/bash
SESSION=$1

# tmux send-keys -t "$SESSION:1" "export WEBKIT_DISABLE_DMABUF_RENDERER=1" Enter
tmux send-keys -t "$SESSION:1" "nvim" Enter

tmux new-window -t "$SESSION:2" -n "ui"
# tmux send-keys -t "$SESSION:2" "export WEBKIT_DISABLE_DMABUF_RENDERER=1" Enter
tmux send-keys -t "$SESSION:2" "cargo tauri dev" Enter

tmux select-window -t "$SESSION:1"
