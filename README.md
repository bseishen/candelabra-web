# Candelabra Web

Browser-based DFU firmware flasher for Candelabra CAN adapters.

## Features

- Flash firmware over USB using WebDFU (no drivers or native tools required)
- Automatic firmware selection based on connected hardware
- Fetches release binaries directly from GitHub Pages
- Supports manual `.bin` and `.hex` file uploads
- Enter DFU mode over USB for devices running Candlelight firmware

## Supported Hardware

| Board | MCU |
|-------|-----|
| Multiboard | STM32G431 |
| Jhoinrch | STM32G431 |
| OpenlightLabs | STM32G431 |
| OleksiiSolo | STM32G431 |
| OleksiiDual | STM32G473 |
| WeActStudioV1 | STM32G0B1 |
| WeActStudioV2 | STM32G431 |

## Firmware Types

- **Candlelight** — gs_usb compatible firmware (supports DFU entry over USB)
- **Slcan** — serial CAN interface (requires BOOT0 jumper for DFU)

## Usage

1. Visit the hosted page at [bseishen.github.io/candelabra-web](https://bseishen.github.io/candelabra-web)
2. Select a release, board, and firmware type
3. Connect your device in DFU mode
4. Click **Connect** and then **Flash**

## Related

- [Candelabra Firmware](https://github.com/bseishen/Candelabra) — firmware source and releases
