import {
  loadCharacterModel,
  loadCharacterAnimation,
  IdleAnimationUrl,
  WalkAnimationUrl,
  RunAnimationUrl,
} from '@pmndrs/viverse';

const VRM_CFG = { format: 'vrm', scale: 1.05, holdOffsetY: -1.85 };

// Full ToxSam open-source-avatars catalog (100avatars-r1, all hosted on Arweave)
const CATALOG = {
  // Local files (already in public/characters/)
  mannequin:  { url: '/characters/mannequin.glb',   format: 'gltf', scale: 1.05, holdOffsetY: -1.85 },
  mushy:      { url: '/characters/Mushy.vrm',        ...VRM_CFG },
  cactusboy:  { url: '/characters/CactusBoy.vrm',    ...VRM_CFG },
  coolbanana: { url: '/characters/CoolBanana.vrm',   ...VRM_CFG },
  hotdog:     { url: '/characters/Hotdog.vrm',       ...VRM_CFG },
  bloody:     { url: '/characters/Bloody.vrm',       ...VRM_CFG },
  cookieman:  { url: '/characters/Cookieman.vrm',    ...VRM_CFG },
  devil:      { url: '/characters/Devil.vrm',        ...VRM_CFG },
  dinokid:    { url: '/characters/DinoKid.vrm',      ...VRM_CFG },
  eggplant:   { url: '/characters/Eggplant.vrm',     ...VRM_CFG },
  nightmare:  { url: '/characters/Nightmare.vrm',    ...VRM_CFG },
  polydancer: { url: '/characters/Polydancer.vrm',   ...VRM_CFG },
  rabbit:     { url: '/characters/Rabbit.vrm',       ...VRM_CFG },
  robert:     { url: '/characters/Robert.vrm',       ...VRM_CFG },
  rose:       { url: '/characters/Rose.vrm',         ...VRM_CFG },
  skull:      { url: '/characters/Skull.vrm',        ...VRM_CFG },

  // Arweave — full 100avatars-r1 catalog
  bullidan:       { url: 'https://arweave.net/uMDSdp_ENC77sR802M7hTFtigxLs0dRuzmkKlLEAa9U', ...VRM_CFG },
  mikel:          { url: 'https://arweave.net/-eJyDjujQRvakRImdvulg-1dKQkPwMeQv-55IbKqLh4', ...VRM_CFG },
  observer:       { url: 'https://arweave.net/bDb0wMAxPHGbhirVjHi-7GF1QL6HrwD8SuKFEF5Sx2M', ...VRM_CFG },
  amazonas:       { url: 'https://arweave.net/fqZDwToo41u1a7VnHhZX1BTK5lktXpK_H6H20MVbPqQ', ...VRM_CFG },
  chad:           { url: 'https://arweave.net/s15TxeRcxamOZ0qDfjME1Bl2Ku7Vs4IQs8RthpxYjOQ', ...VRM_CFG },
  clown:          { url: 'https://arweave.net/pICFDWCb9lHSvhpBkoCXNdG3VngvYhvvi20lK51uwyA', ...VRM_CFG },
  chill:          { url: 'https://arweave.net/JCzmV7mgqDGNDu8YkdSMeJApOA09CCL2i71BqvJKCVs', ...VRM_CFG },
  olivia:         { url: 'https://arweave.net/MgsNlTetzAoVEC6E-lswj65vp7StkOZXXd5OjjqzYZI', ...VRM_CFG },
  sticker:        { url: 'https://arweave.net/y9IXVbhB3QjHN8Iep329h0QEWDl7yMKfvH9p_QxkD0M', ...VRM_CFG },
  zombie:         { url: 'https://arweave.net/hM8199iDasTM_hlX6RykOToEiNHWxAUc8EegeTsjAuE', ...VRM_CFG },
  astrodisco:     { url: 'https://arweave.net/uS4wvZn6sURMWJuwWzWnCqGaqDtZSiQQdTwci0f6hmM', ...VRM_CFG },
  udom:           { url: 'https://arweave.net/VZmDI9KtGRQQziDEURsw0a7cdkbPilVaAnMn3Eck0fg', ...VRM_CFG },
  fungus:         { url: 'https://arweave.net/8I0PA7uqsEBChnWB9dEmOXwLf1bnk2G-Z_AZZrlqwYc', ...VRM_CFG },
  coolchoco:      { url: 'https://arweave.net/hre4rgFOAWthLKTcgQgf5MRp5VcjFBYOofbsPhVqOew', ...VRM_CFG },
  polybot:        { url: 'https://arweave.net/DUR8v-IugXppdMBxPdE1rDO2dZCJJ7ZgBTXSRgPJFNo', ...VRM_CFG },
  ferk:           { url: 'https://arweave.net/-RwzCgnqAniy41JEYP-dGbgGnZJ7GFqEGwliEFHCHaI', ...VRM_CFG },
  erika:          { url: 'https://arweave.net/GZkfa0SNnrBWluRL_pXpakg7T3K3d4l87__wR4mD3UM', ...VRM_CFG },
  mummy:          { url: 'https://arweave.net/JGv7n-LkirsjzCDI5iNnw8SLlpw5_Q7LPw0Ni8RZ8vk', ...VRM_CFG },
  carrot:         { url: 'https://arweave.net/S3t6KT5lUoO1LUZe0iP8VtO_SVW7IVOHM9QMHEHEl64', ...VRM_CFG },
  lydia:          { url: 'https://arweave.net/x48D7v037irPQYG7e0vZLDV1E3x5-KookbP9-vaXvYE', ...VRM_CFG },
  retroman:       { url: 'https://arweave.net/N7Ps0Ad5RNr8JVyTFr0YM5tzlUJvAxeJ362XNn1j86E', ...VRM_CFG },
  snowy:          { url: 'https://arweave.net/Mqs8hdg-1hpeGq8Jl_LCmhTGdydglPm2V2OGc8jJ5DY', ...VRM_CFG },
  coffee:         { url: 'https://arweave.net/JxV2leixFtpOsscIyelJzK6OSA84hnyrWZs7LAMfU8c', ...VRM_CFG },
  ro:             { url: 'https://arweave.net/6S5a74z2s5aZrTE71nJR1a1j9x5v46mPy3MKJZMylwg', ...VRM_CFG },
  samuela:        { url: 'https://arweave.net/4VjBzmk3iDQS0-013pUMFpFYbKGNTL4qcQ-PVwADxk4', ...VRM_CFG },
  anchor:         { url: 'https://arweave.net/GhML2d0T_lBZvRA_S28LWVg9wFCWJWqc0cFsVulQQlo', ...VRM_CFG },
  teddy:          { url: 'https://arweave.net/KbaYR3YmtjweLgEcJAWekeh3MNAlF9ZWOYJkbNfi8MM', ...VRM_CFG },
  saintclaus:     { url: 'https://arweave.net/u6ob7CuUnZ5SRgU1TB8W3RMgG5kajclNZbJoLhR-_8A', ...VRM_CFG },
  milk:           { url: 'https://arweave.net/X3NJlq8p9AsiUIqZhsmByDssKQGYeAZxnFNI0fSULMI', ...VRM_CFG },
  cucumber:       { url: 'https://arweave.net/CI15ScQv7owEU6VPq9zJTRizjwxggGk0nCdz7r1uy58', ...VRM_CFG },
  astronaut:      { url: 'https://arweave.net/T0c0z_XEPQHy3vyXz31XB22s_6JTqHdnau8exq_I8tI', ...VRM_CFG },
  oldmoustache:   { url: 'https://arweave.net/li-q3WXvBik3A1aYyp7azx7Mwce3taHx6OSOE1pHdKk', ...VRM_CFG },
  expol:          { url: 'https://arweave.net/rN6r9zV-eDV1Gf7x8Vt9v-HId117AG2arg8BO3uUvtQ', ...VRM_CFG },
  ghost:          { url: 'https://arweave.net/fSy4hx9L9SqiQIKzjhRLhXzDZpQEJA5izCcDej_WJi8', ...VRM_CFG },
  witch:          { url: 'https://arweave.net/0YLwWzDkvVWn9ttv2RAdc8bvWcCBjvYPpu7fpjpHYU0', ...VRM_CFG },
  mafiossini:     { url: 'https://arweave.net/MRYB-qSnrV11_Sa6BwMOqTEpH7n_bczN_pNY_1q7DOs', ...VRM_CFG },
  watermelon:     { url: 'https://arweave.net/PBumF47DE0ARjiZXj5p5h9YLfkrkd0MNk5K_FMBnEc8', ...VRM_CFG },
  kate:           { url: 'https://arweave.net/1q4IQwLQXJVS0JGSpeXlRdazmZYdwJbmLbTv7o0s5Y8', ...VRM_CFG },
  coolalien:      { url: 'https://arweave.net/FB3g343NrNmQrr4V0191V93pbzOVwTiQWF3PEcL4MNg', ...VRM_CFG },
  chilli:         { url: 'https://arweave.net/vyjPW0lPmim3NkQbVvnhSTvjMBys3sp5bzbIhRnPHRQ', ...VRM_CFG },
  toiletpaper:    { url: 'https://arweave.net/SQ9ZFJIjR6ek3dU76sZmeobQXOzRGYkweKa4CGrpkvg', ...VRM_CFG },
  goodtomato:     { url: 'https://arweave.net/-rMMln4TQxnrC7_Mh_5IFZpzspPjQQNGH3qdPHphDGI', ...VRM_CFG },
  xmastree:       { url: 'https://arweave.net/XDn7Py0hCML4VSgAeIVNBgtPdXzSN8bGX1Y2Mn4M8es', ...VRM_CFG },
  wizzir:         { url: 'https://arweave.net/iGoRAUsB8kVP6pBNajVEDaspCPcvEKFEtnIdruVHyBw', ...VRM_CFG },
  skelly:         { url: 'https://arweave.net/3qGxPjmrwuHxuiT5v4LaR_PVoJ9XYLXLM_N7fdxiF_M', ...VRM_CFG },
  eyelids:        { url: 'https://arweave.net/rAV7_CLsR6IGp472AvzVabjJ9A-GYLdpLhCjPnodFUc', ...VRM_CFG },
  froggy:         { url: 'https://arweave.net/0iS8IZahQQDqY27djsEsshpDmWJHEoOSfxwYVJ1Opys', ...VRM_CFG },
  baldman:        { url: 'https://arweave.net/ZInk8IWljp96ivF7KI3GR49WyLPdI1zretRcEZ8NYyM', ...VRM_CFG },
  dracula:        { url: 'https://arweave.net/KJjpv51m0PwGZIt8ibASjhEGM12FkSLu5tjSS6NyYRg', ...VRM_CFG },
  shiro:          { url: 'https://arweave.net/7skrWhSd_4mrqe-tiqMfCL746xu8UWghRh1dZm7irzM', ...VRM_CFG },
  pipe:           { url: 'https://arweave.net/V3m91yQbbd5HVVeRs2LajZKLN3yLY37NXbr_7CnrwQ8', ...VRM_CFG },
  alwayswatching: { url: 'https://arweave.net/K_E7RQHvk3xyNQldXTzPb1x_4Ws9WVXKIbuXpCXczYQ', ...VRM_CFG },
  wolfman:        { url: 'https://arweave.net/wGhrzz7gMTxVeu8SeinAox3FO57BjQ09xjjcO4bOR9I', ...VRM_CFG },
  angry:          { url: 'https://arweave.net/g3xaZFRmx1O4gT-4equ6pmUMmR2HWRdbc_iFB3-m7ug', ...VRM_CFG },
  jennifer:       { url: 'https://arweave.net/LKp1uJLAZFmncdCNSZ8oopU7ZElXTvn4BmM4CUcFclc', ...VRM_CFG },
  muscary:        { url: 'https://arweave.net/JCPq_-G5ipvtYBQKC0GRKQ-_lOrZ_LYw_jZji8_-sL4', ...VRM_CFG },
  captainlobster: { url: 'https://arweave.net/N-wQWvd1GJQt4L4XA53kVI9r5bqNJWyoSvOH7FVp0Uk', ...VRM_CFG },
  icecream:       { url: 'https://arweave.net/lIgaKYrtBKdPXsUzdOgTpaUGjaGTxUR10hdZmMOEDZE', ...VRM_CFG },
  cappy:          { url: 'https://arweave.net/nj5MQRsykjZVzRifNkrrbYz5i8rdmYLPDy70NjFuaco', ...VRM_CFG },
  disturbing:     { url: 'https://arweave.net/rjTcCws60Zmwn9Sx2B4Xg0Bjp8z2lag8QELnGUDgSUM', ...VRM_CFG },
  aesthetica:     { url: 'https://arweave.net/orNIoMYKafN-EyZRft2No1ZQsPNl3XUcMXhfT2rKQVc', ...VRM_CFG },
  lilbro:         { url: 'https://arweave.net/ekXWzK3wj4Yhw6ztUKGLyJ3Lr4amZELjA4w__K-svMg', ...VRM_CFG },
  present:        { url: 'https://arweave.net/6FIVV-fpxolzreu6VMNNasBzomahHR7-dFDaV172YCs', ...VRM_CFG },
  jimmy:          { url: 'https://arweave.net/mmPA7zxvHTEEmKEAnMPX7jnaT1MD4dqUj8mTPenSAiw', ...VRM_CFG },
  kyle:           { url: 'https://arweave.net/0E5wEEVl5VGCcuGVQylq3dpC3TClLR3JhuhEyhYh7NQ', ...VRM_CFG },
  pepo:           { url: 'https://arweave.net/QaH2oH3i77UCBQZKJuYjn12xqe3huxVVYe3cVt5pEH8', ...VRM_CFG },
  hugo:           { url: 'https://arweave.net/iYaEdMdq8faogyRdgF4plnZIq40oOERENie94XmEdvQ', ...VRM_CFG },
  butter:         { url: 'https://arweave.net/A6-htjkKLc1zwkKgwBzJDdWwF88r4leGz9KnN66WeX8', ...VRM_CFG },
  horrornurse:    { url: 'https://arweave.net/-0bKfdGsrtYAOdxaLhOkI9suGi9fibAh7d_wwiWd0-M', ...VRM_CFG },
  scarecrow:      { url: 'https://arweave.net/cx3fHafcbD9fukDYD7nJjCRlb1DBKZb40uR17GSVgrI', ...VRM_CFG },
};

// Only expose remote (Arweave) entries — local /characters/ files are not
// bundled in this template, returning HTML 404s that break the GLTF parser.
export const VRM_POOL = Object.keys(CATALOG).filter(
  k => CATALOG[k].url.startsWith('https://')
);

export async function createInstance(type = 'mannequin') {
  const cfg = CATALOG[type];
  if (!cfg) throw new Error(`Unknown character type: ${type}`);

  const model = await loadCharacterModel(cfg.url, cfg.format);

  const [idleClip, walkClip, runClip] = await Promise.all([
    loadCharacterAnimation(model, IdleAnimationUrl, undefined, true),
    loadCharacterAnimation(model, WalkAnimationUrl, undefined, true),
    loadCharacterAnimation(model, RunAnimationUrl,  undefined, true),
  ]);

  const actions = {
    idle: model.mixer.clipAction(idleClip),
    walk: model.mixer.clipAction(walkClip),
    run:  model.mixer.clipAction(runClip),
  };

  return {
    model,
    instance:    model.scene,
    mixer:       model.mixer,
    actions,
    scale:       cfg.scale,
    holdOffsetY: cfg.holdOffsetY,
    isVRM:       cfg.format === 'vrm',
  };
}

export async function preload(types = ['mannequin']) {
  return Promise.all(types.map(t => createInstance(t).catch(() => null)));
}

export const load = () => preload(['mannequin']);
