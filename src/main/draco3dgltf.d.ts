// draco3dgltf ships no types; DeckWerk uses only its decoder (and, in tests,
// encoder) factories, which glTF-Transform takes as opaque modules.
declare module 'draco3dgltf' {
  const draco3d: {
    createDecoderModule(): Promise<unknown>;
    createEncoderModule(): Promise<unknown>;
  };
  export default draco3d;
}
