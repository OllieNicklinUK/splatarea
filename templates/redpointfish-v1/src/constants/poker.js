export const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
export const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export const POINT_VALUES = {
  'A_spades': 30,
  'A_hearts': 20,
  '9_hearts': 9,
  '9_diamonds': 9,
  '8_hearts': 8,
  '8_diamonds': 8,
  '7_hearts': 7,
  '7_diamonds': 7,
  '6_hearts': 6,
  '6_diamonds': 6,
  '5_hearts': 5,
  '5_diamonds': 5,
  '4_hearts': 4,
  '4_diamonds': 4,
  '3_hearts': 3,
  '3_diamonds': 3,
  '2_hearts': 2,
  '2_diamonds': 2,
  '10_hearts': 10,
  '10_diamonds': 10,
  'J_hearts': 10,
  'J_diamonds': 10,
  'Q_hearts': 10,
  'Q_diamonds': 10,
  'K_hearts': 10,
  'K_diamonds': 10,
};

export const getCardPointValue = (card) => {
  const key = `${card.value}_${card.suit}`;
  return POINT_VALUES[key] || 0;
};

export const getCardFaceValue = (value) => {
  if (value === 'A') return 1;
  if (value === 'J' || value === 'Q' || value === 'K') return 10;
  return parseInt(value);
};

export const canCapture = (card1, card2) => {
  const v1 = getCardFaceValue(card1.value);
  const v2 = getCardFaceValue(card2.value);

  if (v1 <= 9) {
    return v1 + v2 === 10;
  } else {
    // 10 captures 10, J captures J, Q captures Q, K captures K
    return v1 === v2;
  }
};
