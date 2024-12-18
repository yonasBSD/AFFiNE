import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const tipsStyle = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
});

export const tipStyle = style({
  display: 'flex',
  flexWrap: 'nowrap',
});

export const bullet = style({
  backgroundColor: cssVarV2('icon/activated'),
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  marginTop: '8px',
  marginLeft: '4px',
  marginRight: '12px',
});

export const modalChildren = style({
  paddingLeft: '0',
});