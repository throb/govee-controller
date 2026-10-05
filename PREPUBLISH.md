# Release verification

- Preserved the repository's existing MIT license and history.
- Removed preview-only playback and the obsolete individual-head output option. Play defaults to local hardware output.
- Compacted the editor and moved optional cloud head calibration into Settings diagnostics.
- Bound browser mutations to a server instance and MCP writes to the matching installation. Launcher refuses unrelated servers.
- Ran 47 Python tests and 7 JavaScript timeline tests, then repeated them against a clean export of the staged repository with no existing data or credentials. All passed.
- Live MCP stdio initialization, 12-tool listing, and saved-show listing succeeded.
- Scanned all staged files against both local saved API keys and known installation identifiers: no matches. Credential and project folders remain ignored.
- README includes Basic/Advanced screenshots, setup, limitations, shortcuts, and bundled MCP documentation.

Physical animation has been confirmed by the user during development. Network command counters verify transmission, not physical light changes. This is a scoped release review, not a guarantee of compatibility with every installation.
