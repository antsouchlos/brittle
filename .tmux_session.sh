#!/bin/bash
SESSION=$1

tmux send-keys -t "$SESSION:1" "nvim" Enter

