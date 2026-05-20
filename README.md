# Brittle

## Build & Run

- Run in development mode
    ```
    $ cargo tauri dev
    ```
- Compile binary
    ```
    $ cargo tauri build --no-bundle
    ```

## Troubleshooting

If the UI feels laggy, try

```
export WEBKIT_DISABLE_DMABUF_RENDERER=1
```
